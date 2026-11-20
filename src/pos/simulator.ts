import { Db } from '../db/index.js';
import { lineAmount } from '../lib/money.js';
import { nowIso, randomToken } from '../lib/util.js';
import type { FinalizeRequest, HeldBasketRequest, PosAdapter, PosCatalogueItem, PosLine, SaleResult } from './adapter.js';
import { PosError } from './adapter.js';

/**
 * Local POS simulator used in DEMO MODE and tests. It lives in its own SQLite
 * file to behave like an external system and keep demo data apart.
 *
 * Fault injection lets you rehearse failures:
 *   down                  - every call fails before anything is applied
 *   timeout_after_commit  - the call is applied but the response is "lost" (uncertain)
 */
export type SimFault = 'none' | 'down' | 'timeout_after_commit';

export class SimulatedPos implements PosAdapter {
  readonly name = 'simulator';
  readonly db: Db;
  fault: SimFault = 'none';
  /** apply the fault only to the next N calls (Infinity = until cleared) */
  faultCalls = Infinity;

  constructor(file: string) {
    this.db = new Db(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sim_items (
        pos_item_id TEXT PRIMARY KEY, data TEXT NOT NULL, stock_milli INTEGER NOT NULL DEFAULT 100000000
      );
      CREATE TABLE IF NOT EXISTS sim_held (
        pos_ref TEXT PRIMARY KEY, external_ref TEXT NOT NULL UNIQUE, request_key TEXT NOT NULL UNIQUE,
        branch_id TEXT, order_code TEXT, lines TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sim_sales (
        sale_id TEXT PRIMARY KEY, pos_ref TEXT NOT NULL UNIQUE, attempt_key TEXT NOT NULL UNIQUE, receipt_no TEXT NOT NULL UNIQUE,
        total_paise INTEGER NOT NULL, round_off_paise INTEGER NOT NULL, method TEXT, cashier TEXT, lines TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sim_stock_moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id TEXT NOT NULL, pos_item_id TEXT NOT NULL, delta_milli INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sim_counters (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
    `);
  }

  private maybeFail(stage: 'before' | 'after') {
    if (this.fault === 'none' || this.faultCalls <= 0) return;
    if (this.fault === 'down' && stage === 'before') {
      this.faultCalls--;
      throw new PosError('POS unreachable (simulated)', false, 'POS_DOWN');
    }
    if (this.fault === 'timeout_after_commit' && stage === 'after') {
      this.faultCalls--;
      throw new PosError('POS response timed out (simulated)', true, 'POS_TIMEOUT');
    }
  }
  setFault(f: SimFault, calls = Infinity) {
    this.fault = f;
    this.faultCalls = calls;
  }

  // ---- catalogue management (simulator only) ----
  upsertItem(item: PosCatalogueItem) {
    this.db.run(
      `INSERT INTO sim_items (pos_item_id, data) VALUES (?, ?) ON CONFLICT(pos_item_id) DO UPDATE SET data = excluded.data`,
      item.pos_item_id, JSON.stringify(item),
    );
  }
  setPrice(pos_item_id: string, price_paise: number) {
    const r = this.db.get<{ data: string }>('SELECT data FROM sim_items WHERE pos_item_id = ?', pos_item_id);
    if (!r) throw new Error('unknown item');
    const d = JSON.parse(r.data);
    d.price_paise = price_paise;
    this.upsertItem(d);
  }
  stockOf(pos_item_id: string) {
    return this.db.get<{ stock_milli: number }>('SELECT stock_milli FROM sim_items WHERE pos_item_id = ?', pos_item_id)?.stock_milli;
  }
  private item(pos_item_id: string): PosCatalogueItem | undefined {
    const r = this.db.get<{ data: string }>('SELECT data FROM sim_items WHERE pos_item_id = ?', pos_item_id);
    return r ? JSON.parse(r.data) : undefined;
  }
  private nextSeq(k: string) {
    this.db.run('INSERT INTO sim_counters (k, v) VALUES (?, 1) ON CONFLICT(k) DO UPDATE SET v = v + 1', k);
    return this.db.get<{ v: number }>('SELECT v FROM sim_counters WHERE k = ?', k)!.v;
  }

  // ---- PosAdapter ----
  async health() {
    if (this.fault === 'down' && this.faultCalls > 0) return { ok: false, detail: 'Simulated outage' };
    return { ok: true, detail: 'POS simulator (demo)' };
  }

  async fetchCatalogue(): Promise<PosCatalogueItem[]> {
    this.maybeFail('before');
    return this.db.all<{ data: string; stock_milli: number }>('SELECT data, stock_milli FROM sim_items ORDER BY pos_item_id').map((r) => {
      const d = JSON.parse(r.data) as PosCatalogueItem;
      return { ...d, available: d.available && r.stock_milli > 0 };
    });
  }

  async createHeldBasket(req: HeldBasketRequest) {
    this.maybeFail('before');
    const existing = this.db.get<{ pos_ref: string }>('SELECT pos_ref FROM sim_held WHERE request_key = ? OR external_ref = ?', req.request_key, req.external_ref);
    if (existing) return { pos_ref: existing.pos_ref };
    for (const l of req.lines) if (!this.item(l.pos_item_id)) throw new PosError(`Unknown item ${l.pos_item_id}`, false, 'UNKNOWN_ITEM');
    const pos_ref = `HB-${String(this.nextSeq('held')).padStart(6, '0')}`;
    const ts = nowIso();
    this.db.run(
      'INSERT INTO sim_held (pos_ref, external_ref, request_key, branch_id, order_code, lines, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      pos_ref, req.external_ref, req.request_key, req.branch_id, req.order_code, JSON.stringify(req.lines), 'held', ts, ts,
    );
    this.maybeFail('after');
    return { pos_ref };
  }

  async findHeldBasket(external_ref: string) {
    this.maybeFail('before');
    return this.db.get<{ pos_ref: string; status: string }>('SELECT pos_ref, status FROM sim_held WHERE external_ref = ?', external_ref) ?? null;
  }

  async updateHeldBasket(pos_ref: string, lines: PosLine[]) {
    this.maybeFail('before');
    const h = this.db.get<{ status: string }>('SELECT status FROM sim_held WHERE pos_ref = ?', pos_ref);
    if (!h) throw new PosError('Unknown held basket', false, 'NOT_FOUND');
    if (h.status !== 'held') throw new PosError(`Held basket is ${h.status}`, false, 'NOT_HELD');
    this.db.run('UPDATE sim_held SET lines = ?, updated_at = ? WHERE pos_ref = ?', JSON.stringify(lines), nowIso(), pos_ref);
  }

  async voidHeldBasket(pos_ref: string, reason: string) {
    this.maybeFail('before');
    this.db.run(`UPDATE sim_held SET status = 'void', updated_at = ? WHERE pos_ref = ? AND status = 'held'`, nowIso(), pos_ref);
    void reason;
  }

  async finalizeSale(req: FinalizeRequest): Promise<SaleResult> {
    this.maybeFail('before');
    const prior = await this.lookupSale(req.attempt_key);
    if (prior) return prior;
    const result = this.db.tx(() => {
      const h = this.db.get<{ status: string }>('SELECT status FROM sim_held WHERE pos_ref = ?', req.pos_ref);
      if (!h) throw new PosError('Unknown held basket', false, 'NOT_FOUND');
      if (h.status === 'sold') throw new PosError('This basket has already been sold', false, 'ALREADY_SOLD');
      if (h.status !== 'held') throw new PosError(`Held basket is ${h.status}`, false, 'NOT_HELD');
      // POS is the pricing authority: re-price from its own item master.
      let subtotal = 0;
      const priced = req.lines.map((l) => {
        const it = this.item(l.pos_item_id);
        if (!it) throw new PosError(`Unknown item ${l.pos_item_id}`, false, 'UNKNOWN_ITEM');
        if (it.sold_by === 'weight' && (!l.weighed || !l.grams)) throw new PosError(`Item ${it.name_en} must be weighed`, false, 'NEEDS_WEIGHT');
        const amt = lineAmount({ sold_by: it.sold_by, unit_price_paise: it.price_paise, qty: l.qty, actual_grams: l.grams ?? null });
        subtotal += amt.paise;
        return { ...l, unit_price_paise: it.price_paise, amount_paise: amt.paise };
      });
      const total = Math.round(subtotal / 100) * 100; // round to the nearest rupee, like many Indian POS
      const seq = this.nextSeq('receipt');
      const sale: SaleResult = {
        sale_id: `S-${randomToken(6)}`,
        receipt_no: `MPC/${new Date().getFullYear()}/${String(seq).padStart(6, '0')}`,
        total_paise: total,
        round_off_paise: total - subtotal,
        pos_ref: req.pos_ref,
        attempt_key: req.attempt_key,
      };
      const ts = nowIso();
      this.db.run(
        'INSERT INTO sim_sales (sale_id, pos_ref, attempt_key, receipt_no, total_paise, round_off_paise, method, cashier, lines, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        sale.sale_id, sale.pos_ref, sale.attempt_key, sale.receipt_no, sale.total_paise, sale.round_off_paise, req.method, req.cashier, JSON.stringify(priced), ts,
      );
      for (const l of priced) {
        const delta = l.grams && this.item(l.pos_item_id)!.sold_by === 'weight' ? -l.grams : -l.qty * 1000;
        this.db.run('INSERT INTO sim_stock_moves (sale_id, pos_item_id, delta_milli, created_at) VALUES (?,?,?,?)', sale.sale_id, l.pos_item_id, delta, ts);
        this.db.run('UPDATE sim_items SET stock_milli = stock_milli + ? WHERE pos_item_id = ?', delta, l.pos_item_id);
      }
      this.db.run(`UPDATE sim_held SET status = 'sold', lines = ?, updated_at = ? WHERE pos_ref = ?`, JSON.stringify(req.lines), ts, req.pos_ref);
      return sale;
    });
    this.maybeFail('after');
    return result;
  }

  async lookupSale(attempt_key: string): Promise<SaleResult | null> {
    const r = this.db.get<any>('SELECT * FROM sim_sales WHERE attempt_key = ?', attempt_key);
    return r ? { sale_id: r.sale_id, receipt_no: r.receipt_no, total_paise: r.total_paise, round_off_paise: r.round_off_paise, pos_ref: r.pos_ref, attempt_key: r.attempt_key } : null;
  }

  async listSalesSince(iso: string): Promise<SaleResult[]> {
    return this.db.all<any>('SELECT * FROM sim_sales WHERE created_at >= ? ORDER BY created_at', iso).map((r) => ({
      sale_id: r.sale_id, receipt_no: r.receipt_no, total_paise: r.total_paise, round_off_paise: r.round_off_paise, pos_ref: r.pos_ref, attempt_key: r.attempt_key,
    }));
  }

  /** Simulator-only: number of sales and stock postings recorded for a held basket. */
  postingsFor(pos_ref: string) {
    const sales = this.db.all<{ sale_id: string }>('SELECT sale_id FROM sim_sales WHERE pos_ref = ?', pos_ref);
    const moves = sales.length
      ? this.db.get<{ n: number }>(`SELECT count(*) n FROM sim_stock_moves WHERE sale_id IN (${sales.map(() => '?').join(',')})`, ...sales.map((s) => s.sale_id))!.n
      : 0;
    return { sales: sales.length, stockMoves: moves };
  }
}
