import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createContext, type AppContext } from '../context.js';
import { Worker } from '../worker.js';
import { createApp } from '../server.js';
import { seedDemo, DEMO_PASSWORD } from './seed.js';
import { config } from '../config.js';
import { runAgent } from '../../agent/print-agent.js';

/** Spins up an isolated demo instance (temp databases, random port). Used by tests and `npm run demo:run`. */
export async function startHarness(opts: { dir?: string } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-'));
  fs.mkdirSync(dir, { recursive: true });
  config.checkoutRateLimit = 10_000;
  config.catalogueSyncMinutes = 0;
  const ctx = createContext({ databasePath: path.join(dir, 'app.db'), posSimPath: path.join(dir, 'pos-sim.db') });
  const agentToken = 'mpcagent_test_' + Math.random().toString(36).slice(2);
  const seed = await seedDemo(ctx, { agentToken });
  const worker = new Worker(ctx);
  const app = createApp(ctx, worker);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.publicBaseUrl = base;

  let uaCounter = 0;
  const h = {
    ctx, worker, base, dir, seed, agentToken,
    async close() {
      await new Promise((r) => server.close(r));
      ctx.db.close();
      ctx.sim?.db.close();
    },
    /** One shopper's phone (distinct user agent => distinct fingerprint). */
    customer(name = `phone-${++uaCounter}`) {
      const ua = `Mozilla/5.0 (Linux; Android 14) DemoPhone/${name}`;
      return {
        ua,
        async get(p: string) {
          return fetch(base + p, { headers: { 'user-agent': ua, accept: 'application/json' } });
        },
        async checkout(lines: unknown[], key: string, branch = 'main') {
          const r = await fetch(`${base}/api/b/${branch}/checkout`, {
            method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': key, 'user-agent': ua },
            body: JSON.stringify({ lines }),
          });
          return { status: r.status, body: (await r.json()) as any };
        },
      };
    },
    async staff(username: string, password = DEMO_PASSWORD) {
      const login = await fetch(`${base}/staff/login`, {
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ username, password }),
      });
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
      if (!cookie.startsWith('mpc_staff=')) throw new Error(`login failed for ${username}: ${login.status}`);
      const page = await (await fetch(`${base}/staff`, { headers: { cookie } })).text();
      const csrf = page.match(/name="csrf-token" content="([^"]+)"/)?.[1] ?? '';
      const call = async (p: string, body: Record<string, unknown> = {}) => {
        const r = await fetch(base + p, {
          method: 'POST', headers: { cookie, 'content-type': 'application/json', accept: 'application/json', 'x-csrf-token': csrf, 'x-requested-with': 'fetch' }, body: JSON.stringify(body),
        });
        return { status: r.status, body: (await r.json()) as any };
      };
      return { cookie, csrf, post: call, get: (p: string) => fetch(base + p, { headers: { cookie } }) };
    },
    /** Run one print-agent cycle against a printer target (dir:..., fail, stdout). */
    async agentCycle(target = `dir:${path.join(dir, 'prints')}`) {
      const logs: string[] = [];
      await runAgent({ server: base, token: agentToken, printers: {}, defaultTarget: target, pollMs: 10, stateFile: path.join(dir, 'agent-state.json') }, { once: true, log: (s) => logs.push(s) });
      return logs;
    },
    item(posId: string) {
      return ctx.db.get<any>('SELECT * FROM items WHERE pos_item_id = ?', posId)!;
    },
  };
  return h;
}
export type Harness = Awaited<ReturnType<typeof startHarness>>;
export type { AppContext };
