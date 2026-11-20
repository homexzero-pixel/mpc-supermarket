import type { Db, Row } from '../db/index.js';
import { formatGrams } from '../lib/money.js';
import { addSeconds, newId, nowIso, sha256, storeTime } from '../lib/util.js';
import { charsForPaper, renderPreview, slipMoney, type SlipDoc, type SlipOp } from './slip.js';
import { lineAmount, basketTotal } from '../lib/money.js';
import { config } from '../config.js';

export type PrintKind = 'original' | 'copy' | 'transfer' | 'test';

export function orderBarcodeData(order: { business_date: string; code: string }) {
  return `SS-${order.business_date.replace(/-/g, '')}-${order.code}`;
}
export function parseOrderBarcode(s: string): { business_date: string; code: string } | null {
  const m = s.trim().toUpperCase().match(/^SS-(\d{4})(\d{2})(\d{2})-([A-Z]{1,3}\d{3,4})$/);
  return m ? { business_date: `${m[1]}-${m[2]}-${m[3]}`, code: m[4] } : null;
}

export class PrintService {
  constructor(private db: Db) {}

  alert(branch_id: string, kind: string, message: string, refs: { order_id?: string; print_job_id?: string } = {}) {
    if (refs.print_job_id && this.db.get('SELECT 1 FROM alerts WHERE print_job_id = ? AND kind = ? AND resolved_at IS NULL', refs.print_job_id, kind)) return;
    this.db.run(
      'INSERT INTO alerts (branch_id, kind, message, order_id, print_job_id, created_at) VALUES (?,?,?,?,?,?)',
      branch_id, kind, message, refs.order_id ?? null, refs.print_job_id ?? null, nowIso(),
    );
  }

  buildOrderSlip(order: Row, lines: Row[], counter: Row | undefined, branch: Row, printer: Row | undefined, kind: PrintKind, note?: string): SlipDoc {
    const W = charsForPaper(printer?.paper_width_mm ?? 80);
    const lang = printer?.language ?? 'en';
    const ops: SlipOp[] = [];
    const store = JSON.parse(branch.store_info || '{}');
    if (kind === 'copy') ops.push({ t: 'text', s: '*** COPY - REPRINT ***', align: 'center', bold: true });
    if (kind === 'transfer') ops.push({ t: 'text', s: '*** MOVED TO THIS COUNTER ***', align: 'center', bold: true });
    ops.push({ t: 'text', s: store.brand_short ?? 'MPC', align: 'center', bold: true, size: 2 });
    ops.push({ t: 'text', s: 'Madhuram Pazhamudhir Cholai', align: 'center' });
    ops.push({ t: 'text', s: branch.name_en, align: 'center' });
    ops.push({ t: 'text', s: 'SCAN & SHOP', align: 'center', bold: true });
    ops.push({ t: 'rule', ch: '=' });
    ops.push({ t: 'text', s: counter ? `COUNTER ${counter.number}` : 'ANY COUNTER', align: 'center', bold: true, size: 2 });
    ops.push({ t: 'text', s: order.code, align: 'center', bold: true, size: 3 });
    ops.push({ t: 'text', s: 'AWAITING PAYMENT', align: 'center', bold: true, invert: true });
    ops.push({ t: 'text', s: storeTime(order.created_at), align: 'center' });
    if (order.is_demo || config.demoMode) ops.push({ t: 'text', s: 'DEMO - NOT A REAL ORDER', align: 'center', bold: true });
    ops.push({ t: 'rule' });
    const active = lines.filter((l) => l.qty > 0);
    let n = 0;
    for (const l of active) {
      n++;
      const name = lang === 'ta' && l.name_ta ? l.name_ta : l.name_snapshot;
      const pack = l.pack_label ? ` (${l.pack_label})` : '';
      const amt = lineAmount(l as any);
      if (l.sold_by === 'weight') {
        const right = amt.unknown ? 'WEIGH' : (amt.estimated ? '~' : '') + slipMoney(amt.paise);
        ops.push({ t: 'row', left: `${n}. ${name}`, alt: `${n}. ${l.name_snapshot}`, right, bold: true });
        const w = l.actual_grams != null ? `   Weighed ${formatGrams(l.actual_grams)}` : l.est_grams != null ? `   Approx ${formatGrams(l.est_grams)} - WEIGH AT COUNTER` : '   WEIGH AT COUNTER';
        ops.push({ t: 'text', s: `${w} @ ${slipMoney(l.unit_price_paise)}/kg` });
      } else {
        ops.push({ t: 'row', left: `${n}. ${name}${pack}`, alt: `${n}. ${l.name_snapshot}${pack}`, right: slipMoney(amt.paise) });
        ops.push({ t: 'text', s: `   ${l.qty} x ${slipMoney(l.unit_price_paise)}` });
      }
    }
    ops.push({ t: 'rule' });
    const tot = basketTotal(active as any);
    const units = active.reduce((s, l) => s + (l.sold_by === 'weight' ? 1 : l.qty), 0);
    ops.push({ t: 'row', left: `Lines ${active.length} / Units ${units}`, right: '' });
    ops.push({ t: 'row', left: tot.estimated ? 'ESTIMATED TOTAL' : 'TOTAL (before billing)', right: slipMoney(tot.paise), bold: true });
    if (tot.estimated) ops.push({ t: 'text', s: 'Loose items to be weighed. Final amount on POS bill.' });
    ops.push({ t: 'rule' });
    ops.push({ t: 'barcode', data: orderBarcodeData(order as any) });
    ops.push({ t: 'text', s: 'Scan or type the code at the POS to open this basket.', align: 'center' });
    if (note) ops.push({ t: 'text', s: note, align: 'center' });
    ops.push({ t: 'cut' });
    return { width_chars: W, ops };
  }

  buildTestSlip(branch: Row, printer: Row, by: string): SlipDoc {
    const W = charsForPaper(printer.paper_width_mm);
    return {
      width_chars: W,
      ops: [
        { t: 'text', s: 'MPC TEST SLIP', align: 'center', bold: true, size: 2 },
        { t: 'text', s: `${branch.name_en} - ${printer.name}`, align: 'center' },
        { t: 'text', s: `Paper ${printer.paper_width_mm} mm / ${W} chars`, align: 'center' },
        { t: 'text', s: storeTime(nowIso()), align: 'center' },
        { t: 'rule' },
        { t: 'text', s: '1234567890'.repeat(5).slice(0, W) },
        { t: 'row', left: 'A very long product name that should wrap neatly onto the next line (1 kg)', right: slipMoney(123456) },
        { t: 'text', s: 'தமிழ் சோதனை', alt: '(Tamil text needs raster mode)', align: 'center' },
        { t: 'barcode', data: 'SS-20260101-M001' },
        { t: 'text', s: `Requested by ${by}`, align: 'center' },
        { t: 'cut' },
      ],
    };
  }

  /** Create a print job. The partial unique index guarantees one ORIGINAL per order. */
  createJob(opts: { order?: Row; branch: Row; counter?: Row; kind: PrintKind; doc: SlipDoc; createdBy?: string; reason?: string }) {
    const printer = opts.counter?.printer_id ? this.db.get<Row>('SELECT * FROM printers WHERE id = ? AND active = 1', opts.counter.printer_id) : undefined;
    const id = newId('pj');
    const ts = nowIso();
    if (opts.kind === 'original' && opts.order && this.db.get(`SELECT 1 FROM print_jobs WHERE order_id = ? AND kind = 'original'`, opts.order.id)) return null;
    this.db.run(
      `INSERT INTO print_jobs (id, order_id, branch_id, printer_id, counter_id, kind, status, payload, preview, created_by, reason, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, opts.order?.id ?? null, opts.branch.id, printer?.id ?? null, opts.counter?.id ?? null, opts.kind,
      printer ? 'queued' : 'failed', JSON.stringify(opts.doc), renderPreview(opts.doc), opts.createdBy ?? null, opts.reason ?? null, ts, ts,
    );
    if (!printer) {
      this.db.run(`UPDATE print_jobs SET error = 'No active printer assigned to this counter' WHERE id = ?`, id);
      this.alert(opts.branch.id, 'print_failed', `No printer assigned for ${opts.counter ? 'Counter ' + opts.counter.number : 'this order'}${opts.order ? ' (order ' + opts.order.code + ')' : ''}`, { order_id: opts.order?.id, print_job_id: id });
    }
    return id;
  }

  // ---- print agent protocol ----
  agentByToken(token: string) {
    return this.db.get<Row>('SELECT * FROM print_agents WHERE token_hash = ? AND active = 1', sha256(token));
  }

  /** Lease up to `max` queued jobs for printers served by this agent. */
  claimJobs(agent: Row, max = 5) {
    const ts = nowIso();
    this.db.run('UPDATE print_agents SET last_seen_at = ? WHERE id = ?', ts, agent.id);
    return this.db.tx(() => {
      const jobs = this.db.all<Row>(
        `SELECT j.*, p.paper_width_mm, p.name printer_name FROM print_jobs j JOIN printers p ON p.id = j.printer_id
         WHERE p.agent_id = ? AND p.branch_id = ? AND j.status = 'queued' ORDER BY j.created_at LIMIT ?`,
        agent.id, agent.branch_id, max,
      );
      for (const j of jobs) {
        this.db.run(
          `UPDATE print_jobs SET status = 'claimed', agent_id = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'`,
          agent.id, addSeconds(ts, config.printLeaseSeconds), ts, j.id,
        );
      }
      return jobs.map((j) => ({ id: j.id, kind: j.kind, printer_id: j.printer_id, printer_name: j.printer_name, doc: JSON.parse(j.payload) as SlipDoc }));
    });
  }

  /**
   * Agent reports the outcome:
   *  sent    - the printer accepted the bytes; physical confirmation unavailable
   *  printed - the printer confirmed (status query) the job completed
   *  failed  - nothing was sent (e.g. connection refused, paper out before sending): safe to retry the original
   *  unknown - bytes may have been partially sent: staff decide whether to reprint a COPY
   */
  report(agent: Row, jobId: string, status: 'sent' | 'printed' | 'failed' | 'unknown', error?: string) {
    const job = this.db.get<Row>('SELECT * FROM print_jobs WHERE id = ? AND agent_id = ?', jobId, agent.id);
    if (!job) return false;
    if (!['claimed', 'unknown'].includes(job.status)) return true; // late/duplicate report
    this.db.run('UPDATE print_jobs SET status = ?, error = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?', status, error ?? null, nowIso(), jobId);
    if (job.order_id) {
      this.db.run(
        `INSERT INTO order_events (order_id, at, actor_type, actor_id, type, data) VALUES (?,?,?,?,?,?)`,
        job.order_id, nowIso(), 'agent', agent.id, `print_${status}`, JSON.stringify({ job: jobId, kind: job.kind, error }),
      );
    }
    if (status === 'failed' || status === 'unknown') {
      const order = job.order_id ? this.db.get<Row>('SELECT code FROM orders WHERE id = ?', job.order_id) : undefined;
      this.alert(job.branch_id, status === 'failed' ? 'print_failed' : 'print_unknown',
        `${status === 'failed' ? 'Slip did not print' : 'Slip may not have printed'}${order ? ' for order ' + order.code : ''}: ${error ?? 'no detail'}`,
        { order_id: job.order_id, print_job_id: jobId });
    } else {
      this.db.run(`UPDATE alerts SET resolved_at = ?, resolved_by = 'agent' WHERE print_job_id = ? AND resolved_at IS NULL`, nowIso(), jobId);
    }
    return true;
  }

  heartbeat(agent: Row, status: unknown) {
    this.db.run('UPDATE print_agents SET last_seen_at = ?, last_status = ? WHERE id = ?', nowIso(), JSON.stringify(status ?? {}).slice(0, 4000), agent.id);
  }

  /** Leases that expired without a report -> delivery uncertain. Never auto-reprint. */
  expireLeases() {
    const ts = nowIso();
    const stale = this.db.all<Row>(`SELECT * FROM print_jobs WHERE status = 'claimed' AND lease_expires_at < ?`, ts);
    for (const j of stale) {
      this.db.run(`UPDATE print_jobs SET status = 'unknown', error = 'Print agent did not confirm in time', updated_at = ? WHERE id = ? AND status = 'claimed'`, ts, j.id);
      const order = j.order_id ? this.db.get<Row>('SELECT code FROM orders WHERE id = ?', j.order_id) : undefined;
      this.alert(j.branch_id, 'print_unknown', `Slip status unknown${order ? ' for order ' + order.code : ''}: print agent did not confirm`, { order_id: j.order_id, print_job_id: j.id });
    }
    return stale.length;
  }

  /** Re-queue a job that definitively FAILED (nothing printed). Uncertain jobs must use reprintCopy. */
  retryFailed(jobId: string) {
    const job = this.db.get<Row>('SELECT * FROM print_jobs WHERE id = ?', jobId);
    if (!job || job.status !== 'failed') return false;
    if (job.counter_id) {
      const c = this.db.get<Row>('SELECT printer_id FROM counters WHERE id = ?', job.counter_id);
      if (c?.printer_id) this.db.run('UPDATE print_jobs SET printer_id = ? WHERE id = ?', c.printer_id, jobId);
    }
    const r = this.db.run(`UPDATE print_jobs SET status = 'queued', error = NULL, updated_at = ? WHERE id = ? AND status = 'failed' AND printer_id IS NOT NULL`, nowIso(), jobId);
    if (r.changes) this.db.run(`UPDATE alerts SET resolved_at = ?, resolved_by = 'retry' WHERE print_job_id = ? AND resolved_at IS NULL`, nowIso(), jobId);
    return r.changes > 0;
  }

  printerStatus(branch_id: string) {
    return this.db.all<Row>(
      `SELECT p.*, a.name agent_name, a.last_seen_at, a.last_status,
        (SELECT count(*) FROM print_jobs j WHERE j.printer_id = p.id AND j.status IN ('queued','claimed')) pending,
        (SELECT count(*) FROM print_jobs j WHERE j.printer_id = p.id AND j.status IN ('failed','unknown')) problems
       FROM printers p LEFT JOIN print_agents a ON a.id = p.agent_id WHERE p.branch_id = ? ORDER BY p.name`,
      branch_id,
    ).map((p) => {
      const seen = p.last_seen_at ? (Date.now() - Date.parse(p.last_seen_at)) / 1000 : Infinity;
      const st = JSON.parse(p.last_status || '{}');
      const printerState = st.printers?.[p.id];
      return { ...p, agent_online: seen < 30, seconds_since_seen: Math.round(seen), printer_state: printerState };
    });
  }
}
