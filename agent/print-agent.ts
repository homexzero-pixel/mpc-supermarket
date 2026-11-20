/**
 * MPC store print agent — runs on the counter computer.
 *
 * It makes OUTBOUND HTTPS requests only (no inbound ports to open in the shop):
 *   1. POST /api/agent/jobs/claim   -> leases queued slips for this agent's printers
 *   2. sends each slip to the local thermal printer (ESC/POS)
 *   3. POST /api/agent/jobs/:id/report with sent | printed | failed | unknown
 *
 * Printer targets (per printer id, from agent.config.json or env):
 *   tcp://192.168.1.50:9100   network thermal printer (raw port 9100)
 *   file:/dev/usb/lp0         USB printer device on Linux
 *   file:\\\\localhost\\POS80   shared Windows printer (raw/"Generic / Text Only" driver)
 *   dir:./data/sim-prints     simulator: writes .bin + .txt files (demo mode)
 *   stdout                    prints the text preview to the console
 *   fail                      simulates a switched-off printer
 *
 * Outcome rules (so an original slip is never printed twice by accident):
 *   failed  - definitely nothing printed (connection refused, paper out before sending)
 *   unknown - bytes may have reached the printer (error mid-send) -> staff decide on a COPY
 *   sent    - printer accepted all bytes; physical confirmation not available
 *   printed - simulator / confirmed by status query after printing
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { encodeEscPos, PAPER_STATUS_REQUEST, paperStatusFromByte } from '../src/print/escpos.js';
import { renderPreview, type SlipDoc } from '../src/print/slip.js';

interface PrinterCfg { target: string; statusQuery?: boolean }
interface AgentConfig { server: string; token: string; printers: Record<string, PrinterCfg>; defaultTarget?: string; pollMs?: number; stateFile?: string }

function loadConfig(): AgentConfig {
  const file = process.env.AGENT_CONFIG;
  const fromFile: Partial<AgentConfig> = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const printers: Record<string, PrinterCfg> = { ...(fromFile.printers ?? {}) };
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^PRINTER_(.+)$/);
    if (m && v) printers[m[1]] = { target: v, statusQuery: process.env[`STATUS_QUERY_${m[1]}`] === '1' };
  }
  const cfg: AgentConfig = {
    server: (process.env.MPC_SERVER_URL ?? fromFile.server ?? 'http://localhost:3000').replace(/\/$/, ''),
    token: process.env.MPC_AGENT_TOKEN ?? fromFile.token ?? '',
    printers,
    defaultTarget: process.env.DEFAULT_PRINTER_TARGET ?? fromFile.defaultTarget,
    pollMs: Number(process.env.POLL_MS ?? fromFile.pollMs ?? 2000),
    stateFile: process.env.AGENT_STATE_FILE ?? fromFile.stateFile ?? 'data/agent-pending-reports.json',
  };
  if (!cfg.token) throw new Error('MPC_AGENT_TOKEN (or "token" in AGENT_CONFIG) is required');
  return cfg;
}

type Outcome = { status: 'sent' | 'printed' | 'failed' | 'unknown'; error?: string };
const printerState: Record<string, { state: string; detail?: string; at: string }> = {};

function setState(id: string, state: string, detail?: string) {
  printerState[id] = { state, detail, at: new Date().toISOString() };
}

/** Ask an ESC/POS printer for its paper sensor status (DLE EOT 4). */
function queryPaper(sock: net.Socket, timeoutMs = 1500): Promise<'ok' | 'near_end' | 'out' | 'no_reply'> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { sock.removeListener('data', onData); resolve('no_reply'); }, timeoutMs);
    const onData = (b: Buffer) => { clearTimeout(t); sock.removeListener('data', onData); resolve(paperStatusFromByte(b[0])); };
    sock.on('data', onData);
    sock.write(PAPER_STATUS_REQUEST);
  });
}

function sendTcp(host: string, port: number, data: Buffer, statusQuery: boolean): Promise<Outcome> {
  return new Promise((resolve) => {
    let connected = false;
    let writing = false;
    let settled = false;
    const finish = (o: Outcome) => { if (!settled) { settled = true; sock.destroy(); resolve(o); } };
    const sock = net.connect({ host, port });
    sock.setTimeout(8000);
    sock.on('connect', async () => {
      connected = true;
      if (statusQuery) {
        const paper = await queryPaper(sock);
        if (paper === 'out') return finish({ status: 'failed', error: 'Printer reports PAPER OUT' });
      }
      writing = true;
      sock.write(data, (err) => {
        if (err) return finish({ status: 'unknown', error: `Write error: ${err.message}` });
        sock.end(() => finish({ status: 'sent' }));
      });
    });
    sock.on('timeout', () => finish(connected && writing ? { status: 'unknown', error: 'Printer stopped responding during print' } : { status: 'failed', error: 'Printer did not answer (timeout)' }));
    sock.on('error', (e: NodeJS.ErrnoException) => finish(writing ? { status: 'unknown', error: `${e.code ?? e.message} during print` } : { status: 'failed', error: `${e.code ?? e.message} — is the printer on and connected?` }));
  });
}

async function deliver(printerId: string, target: string, cfg: PrinterCfg | undefined, doc: SlipDoc, jobId: string): Promise<Outcome> {
  const data = encodeEscPos(doc);
  if (target === 'fail') return { status: 'failed', error: 'ECONNREFUSED (simulated: printer switched off)' };
  if (target === 'stdout') {
    console.log(`\n----- ${printerId} / ${jobId} -----\n${renderPreview(doc, { useAlt: true })}\n`);
    return { status: 'printed' };
  }
  if (target.startsWith('dir:')) {
    const dir = path.resolve(target.slice(4));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, `${stamp}_${printerId}_${jobId}.bin`), data);
    fs.writeFileSync(path.join(dir, `${stamp}_${printerId}_${jobId}.txt`), renderPreview(doc, { useAlt: true }));
    return { status: 'printed' };
  }
  if (target.startsWith('tcp://')) {
    const u = new URL(target);
    return sendTcp(u.hostname, Number(u.port || 9100), data, !!cfg?.statusQuery);
  }
  if (target.startsWith('file:')) {
    const p = target.slice(5);
    try {
      const fd = fs.openSync(p, 'w');
      try {
        fs.writeSync(fd, data);
      } catch (e: any) {
        return { status: 'unknown', error: `Write failed mid-print: ${e.code ?? e.message}` };
      } finally {
        fs.closeSync(fd);
      }
      return { status: 'sent' };
    } catch (e: any) {
      return { status: 'failed', error: `${e.code ?? e.message} opening ${p}` };
    }
  }
  return { status: 'failed', error: `No printer target configured for ${printerId}` };
}

// ---- reports survive network drops and agent restarts ----
function loadPending(file: string): { id: string; body: Outcome }[] {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function savePending(file: string, list: { id: string; body: Outcome }[]) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list));
}

export async function runAgent(cfg = loadConfig(), opts: { once?: boolean; log?: (s: string) => void } = {}) {
  const log = opts.log ?? ((s: string) => console.log(`[agent ${new Date().toLocaleTimeString()}] ${s}`));
  const headers = { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', accept: 'application/json' };
  let pending = loadPending(cfg.stateFile!);
  let backoff = cfg.pollMs!;
  let stopped = false;

  async function flushReports() {
    const rest: typeof pending = [];
    for (const r of pending) {
      try {
        const res = await fetch(`${cfg.server}/api/agent/jobs/${encodeURIComponent(r.id)}/report`, { method: 'POST', headers, body: JSON.stringify(r.body) });
        if (!res.ok && res.status >= 500) rest.push(r);
      } catch {
        rest.push(r);
      }
    }
    pending = rest;
    savePending(cfg.stateFile!, pending);
  }

  async function cycle() {
    await flushReports();
    const res = await fetch(`${cfg.server}/api/agent/jobs/claim`, {
      method: 'POST', headers, body: JSON.stringify({ max: 5, status: { printers: printerState, pending_reports: pending.length, version: '1.0.0' } }),
    });
    if (res.status === 401) throw new Error('Agent token rejected — create a new one in Admin → Settings → Print agents');
    if (!res.ok) throw new Error(`Server ${res.status}`);
    const { jobs } = (await res.json()) as { jobs: { id: string; printer_id: string; printer_name: string; kind: string; doc: SlipDoc }[] };
    for (const job of jobs) {
      const pc = cfg.printers[job.printer_id];
      const target = pc?.target ?? cfg.defaultTarget ?? '';
      const outcome = await deliver(job.printer_id, target, pc, job.doc, job.id);
      setState(job.printer_id, outcome.status === 'failed' ? 'error' : outcome.status === 'unknown' ? 'warning' : 'ok', outcome.error);
      log(`${job.kind} slip ${job.id} -> ${job.printer_name}: ${outcome.status}${outcome.error ? ' (' + outcome.error + ')' : ''}`);
      pending.push({ id: job.id, body: outcome });
      savePending(cfg.stateFile!, pending);
    }
    await flushReports();
    return jobs.length;
  }

  log(`Connecting to ${cfg.server}; printers: ${Object.keys(cfg.printers).join(', ') || '(default target ' + cfg.defaultTarget + ')'}`);
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  do {
    try {
      await cycle();
      backoff = cfg.pollMs!;
    } catch (e: any) {
      log(`Cannot reach server: ${e.message}. Retrying.`);
      backoff = Math.min(backoff * 2, 30000);
      if (/token rejected/.test(e.message)) backoff = 60000;
    }
    if (opts.once) break;
    await new Promise((r) => setTimeout(r, backoff));
  } while (!stopped);
}

const isMain = process.argv[1] && /print-agent\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  runAgent().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
