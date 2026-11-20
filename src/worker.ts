import type { AppContext } from './context.js';
import { addSeconds, nowIso } from './lib/util.js';
import { config } from './config.js';

/**
 * Background worker: delivers queued baskets to the POS (transactional outbox),
 * voids cancelled baskets, expires abandoned orders, resolves uncertain
 * payments by lookup, flags unconfirmed print jobs, and syncs the catalogue.
 */
export class Worker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastSync = 0;
  private lastHourlyCheck = 0;
  constructor(private ctx: AppContext) {}

  start() {
    this.timer = setInterval(() => void this.tick(), config.workerIntervalMs);
    void this.tick();
  }
  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.processOutbox();
      this.ctx.print.expireLeases();
      this.ctx.orders.expireStale();
      await this.resolvePendingPayments();
      if (Date.now() - this.lastHourlyCheck > 5 * 60000) {
        this.lastHourlyCheck = Date.now();
        this.nuisanceCheck();
      }
      if (config.catalogueSyncMinutes > 0 && Date.now() - this.lastSync > config.catalogueSyncMinutes * 60000) {
        this.lastSync = Date.now();
        await this.ctx.catalogue.syncFromPos(this.ctx.pos, { isDemo: config.demoMode }).catch(() => undefined);
      }
    } catch (e) {
      console.error('[worker]', e);
    } finally {
      this.running = false;
    }
  }

  async processOutbox(limit = 20) {
    const { db, orders } = this.ctx;
    const due = db.all<any>(`SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?`, nowIso(), limit);
    for (const job of due) {
      let result: string;
      try {
        result = job.kind === 'pos_submit' ? await orders.deliverToPos(job.ref_id, job.attempts) : await orders.voidAtPos(job.ref_id);
      } catch (e: any) {
        result = 'retry';
        db.run('UPDATE outbox SET last_error = ? WHERE id = ?', String(e?.message ?? e).slice(0, 500), job.id);
      }
      if (result === 'done') db.run(`UPDATE outbox SET status = 'done', attempts = attempts + 1 WHERE id = ?`, job.id);
      else if (result === 'dead') db.run(`UPDATE outbox SET status = 'dead', attempts = attempts + 1 WHERE id = ?`, job.id);
      else {
        const delay = Math.min(60, 2 ** Math.min(job.attempts, 6));
        db.run(`UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?`, addSeconds(nowIso(), delay), job.id);
      }
    }
    return due.length;
  }

  async resolvePendingPayments() {
    const stale = this.ctx.db.all<any>(`SELECT id FROM orders WHERE payment_status = 'pending' AND updated_at < ?`, addSeconds(nowIso(), -20));
    for (const o of stale) await this.ctx.orders.checkPayment(o.id, null).catch(() => undefined);
  }

  /** The entrance QR can be photographed and shared: alert on unusual volume. */
  nuisanceCheck() {
    const { db, print } = this.ctx;
    const since = addSeconds(nowIso(), -3600);
    for (const b of db.all<any>('SELECT id, max_orders_per_hour_alert FROM branches')) {
      const n = db.get<any>('SELECT count(*) n FROM orders WHERE branch_id = ? AND created_at > ?', b.id, since).n;
      const unpaidExpired = db.get<any>(`SELECT count(*) n FROM orders WHERE branch_id = ? AND created_at > ? AND status = 'expired'`, b.id, since).n;
      if (n > b.max_orders_per_hour_alert && !db.get(`SELECT 1 FROM alerts WHERE branch_id = ? AND kind = 'volume' AND created_at > ?`, b.id, since))
        print.alert(b.id, 'volume', `${n} Scan & Shop baskets in the last hour (${unpaidExpired} expired unpaid). If these look like nuisance orders, pause Scan & Shop in Admin.`);
    }
  }
}
