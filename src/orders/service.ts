import type { Db, Row } from '../db/index.js';
import type { PosAdapter, PosLine } from '../pos/adapter.js';
import { PosError } from '../pos/adapter.js';
import type { CatalogueService, Item } from '../catalogue/service.js';
import { PrintService, parseOrderBarcode } from '../print/service.js';
import { basketTotal, lineAmount } from '../lib/money.js';
import { HttpError, addSeconds, businessDate, hmac, newId, nowIso, randomToken } from '../lib/util.js';
import { config } from '../config.js';
import { validateScaleRules } from '../lib/barcode.js';

export interface CheckoutLineInput {
  item_id: number;
  qty?: number;
  est_grams?: number | null;
  seen_price_paise: number;
  barcode?: string | null;
}
export interface CheckoutInput {
  idempotency_key: string;
  lines: CheckoutLineInput[];
}
export interface BasketChange {
  item_id: number;
  name: string;
  kind: 'price_changed' | 'unavailable' | 'removed' | 'qty_limited';
  old_price_paise?: number;
  new_price_paise?: number;
  max_qty?: number;
}

const OPEN = `('awaiting_payment','in_progress')`;
const MAX_LINES = 120;
const MAX_GRAMS = 25000;

export class OrderService {
  constructor(private db: Db, private catalogue: CatalogueService, private print: PrintService, public pos: PosAdapter) {}

  // ---------- branches & counters ----------
  branchBySlug(slug: string) {
    return this.db.get<Row>('SELECT * FROM branches WHERE slug = ?', slug);
  }
  branch(id: string) {
    return this.db.get<Row>('SELECT * FROM branches WHERE id = ?', id);
  }
  branches() {
    return this.db.all<Row>('SELECT * FROM branches ORDER BY name_en');
  }
  counters(branch_id: string, activeOnly = false) {
    return this.db.all<Row>(`SELECT * FROM counters WHERE branch_id = ? ${activeOnly ? 'AND active = 1' : ''} ORDER BY number`, branch_id);
  }
  counter(id: string | null) {
    return id ? this.db.get<Row>('SELECT * FROM counters WHERE id = ?', id) : undefined;
  }
  scaleRules(branch: Row) {
    try {
      return validateScaleRules(JSON.parse(branch.scale_label_rules || '[]'));
    } catch {
      return [];
    }
  }

  private routeCounter(branch: Row): Row | undefined {
    const active = this.counters(branch.id, true);
    if (!active.length) return undefined;
    if (active.length === 1) return active[0];
    if (branch.routing === 'least_busy') {
      const load = new Map(
        this.db.all<{ counter_id: string; n: number }>(`SELECT counter_id, count(*) n FROM orders WHERE branch_id = ? AND status IN ${OPEN} GROUP BY counter_id`, branch.id).map((r) => [r.counter_id, r.n]),
      );
      return [...active].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.number - b.number)[0];
    }
    if (branch.routing === 'round_robin') {
      const pick = [...active].sort((a, b) => a.rr_seq - b.rr_seq || a.number - b.number)[0];
      this.db.run('UPDATE counters SET rr_seq = (SELECT max(rr_seq) FROM counters WHERE branch_id = ?) + 1 WHERE id = ?', branch.id, pick.id);
      return pick;
    }
    return active.find((c) => c.id === branch.default_counter_id) ?? active[0];
  }

  private nextCode(branch: Row, date: string) {
    const r = this.db.get<{ m: number | null }>(
      `SELECT max(CAST(substr(code, length(?) + 1) AS INTEGER)) m FROM orders WHERE branch_id = ? AND business_date = ?`,
      branch.order_prefix, branch.id, date,
    );
    const n = (r?.m ?? 0) + 1;
    return `${branch.order_prefix}${String(n).padStart(n > 999 ? 4 : 3, '0')}`;
  }

  // ---------- customer checkout ----------
  /**
   * Validate and price a basket against the current catalogue. Returns priced
   * lines and the list of changes the customer must accept before submitting.
   */
  quote(lines: CheckoutLineInput[]) {
    if (!Array.isArray(lines) || lines.length === 0) throw new HttpError(400, 'EMPTY_BASKET', 'Your basket is empty');
    if (lines.length > MAX_LINES) throw new HttpError(400, 'TOO_MANY_LINES', 'Too many different items in one basket');
    const merged = new Map<number, CheckoutLineInput>();
    for (const l of lines) {
      const id = Number(l.item_id);
      if (!Number.isSafeInteger(id)) throw new HttpError(400, 'BAD_ITEM', 'Invalid item');
      const prev = merged.get(id);
      if (prev) {
        prev.qty = (prev.qty ?? 1) + (l.qty ?? 1);
        if (l.est_grams != null) prev.est_grams = (prev.est_grams ?? 0) + Number(l.est_grams);
      } else merged.set(id, { ...l, item_id: id });
    }
    const items = new Map(this.catalogue.byIds([...merged.keys()]).map((i) => [i.id, i]));
    const changes: BasketChange[] = [];
    const priced: { item: Item; qty: number; est_grams: number | null; barcode: string | null }[] = [];
    for (const l of merged.values()) {
      const item = items.get(l.item_id);
      if (!item || !item.active) {
        changes.push({ item_id: l.item_id, name: item?.name_en ?? 'Item', kind: 'removed' });
        continue;
      }
      if (!item.available) {
        changes.push({ item_id: item.id, name: item.name_en, kind: 'unavailable' });
        continue;
      }
      let qty = 1;
      let est: number | null = null;
      if (item.sold_by === 'weight') {
        est = l.est_grams == null || l.est_grams === 0 ? null : Math.round(Number(l.est_grams));
        if (est != null && (!Number.isFinite(est) || est < 1 || est > MAX_GRAMS)) throw new HttpError(400, 'BAD_WEIGHT', `Invalid weight for ${item.name_en}`);
      } else {
        qty = Math.floor(Number(l.qty ?? 1));
        if (!Number.isFinite(qty) || qty < 1) throw new HttpError(400, 'BAD_QTY', `Invalid quantity for ${item.name_en}`);
        if (qty > item.max_qty) {
          changes.push({ item_id: item.id, name: item.name_en, kind: 'qty_limited', max_qty: item.max_qty });
          qty = item.max_qty;
        }
      }
      if (Number(l.seen_price_paise) !== item.price_paise)
        changes.push({ item_id: item.id, name: item.name_en, kind: 'price_changed', old_price_paise: Number(l.seen_price_paise), new_price_paise: item.price_paise });
      priced.push({ item, qty, est_grams: est, barcode: l.barcode ? String(l.barcode).slice(0, 40) : null });
    }
    const total = basketTotal(priced.map((p) => ({ sold_by: p.item.sold_by, unit_price_paise: p.item.price_paise, qty: p.qty, est_grams: p.est_grams })));
    return { priced, changes, total };
  }

  checkout(branch: Row, input: CheckoutInput, ctx: { fingerprint: string }) {
    const key = String(input.idempotency_key ?? '');
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw new HttpError(400, 'BAD_KEY', 'Missing or invalid idempotency key');
    // Idempotent replay: same key -> same order, regardless of what changed since.
    const prior = this.db.get<Row>('SELECT * FROM orders WHERE idempotency_key = ?', key);
    if (prior) {
      if (prior.branch_id !== branch.id) throw new HttpError(409, 'KEY_REUSED', 'This checkout key belongs to another branch');
      return { order: prior, replay: true };
    }
    if (!branch.accepting_orders) throw new HttpError(423, 'PAUSED', branch.pause_message_en || 'Scan & Shop is paused. Please bill at any counter.');

    const { priced, changes, total } = this.quote(input.lines);
    if (changes.length) throw new HttpError(409, 'BASKET_CHANGED', 'Some items changed. Please review your basket.', { changes });
    if (!priced.length) throw new HttpError(400, 'EMPTY_BASKET', 'Your basket is empty');

    const open = this.db.get<{ n: number }>(`SELECT count(*) n FROM orders WHERE branch_id = ? AND status IN ${OPEN}`, branch.id)!.n;
    if (open >= branch.max_open_orders) throw new HttpError(429, 'BUSY', 'The counters are very busy. Please bring your basket to any counter.');
    const mine = this.db.get<{ n: number }>(`SELECT count(*) n FROM orders WHERE branch_id = ? AND client_fingerprint = ? AND status = 'awaiting_payment'`, branch.id, ctx.fingerprint)!.n;
    if (mine >= 3) throw new HttpError(429, 'TOO_MANY_OPEN', 'You already have baskets waiting at the counter. Please pay for those first.');

    const created = this.db.tx(() => {
      const ts = nowIso();
      const date = businessDate();
      const counter = this.routeCounter(branch);
      const id = newId('ord');
      const code = this.nextCode(branch, date);
      const hasUnweighed = priced.some((p) => p.item.sold_by === 'weight');
      this.db.run(
        `INSERT INTO orders (id, branch_id, code, business_date, ticket_token, idempotency_key, counter_id, has_unweighed, est_total_paise,
          client_fingerprint, is_demo, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, branch.id, code, date, randomToken(24), key, counter?.id ?? null, hasUnweighed ? 1 : 0, total.paise, ctx.fingerprint,
        branch.is_demo || config.demoMode ? 1 : 0, ts, ts,
      );
      priced.forEach((p, i) =>
        this.db.run(
          `INSERT INTO order_lines (order_id, item_id, pos_item_id, name_snapshot, pack_label, sold_by, unit_price_paise, submitted_qty, qty, est_grams, scanned_barcode, sort)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, p.item.id, p.item.pos_item_id, p.item.name_en, p.item.pack_label, p.item.sold_by, p.item.price_paise, p.qty, p.qty, p.est_grams, p.barcode, i,
        ),
      );
      this.event(id, 'customer', null, 'submitted', { lines: priced.length, est_total_paise: total.paise, counter: counter?.number ?? null });
      this.db.run(`INSERT INTO outbox (kind, ref_id, next_attempt_at, created_at) VALUES ('pos_submit', ?, ?, ?)`, id, ts, ts);
      const order = this.db.get<Row>('SELECT * FROM orders WHERE id = ?', id)!;
      this.queueSlip(order, 'original');
      return order;
    });
    return { order: created, replay: false };
  }

  private queueSlip(order: Row, kind: 'original' | 'copy' | 'transfer', by?: string, reason?: string) {
    const branch = this.branch(order.branch_id)!;
    const counter = this.counter(order.counter_id);
    const printer = counter?.printer_id ? this.db.get<Row>('SELECT * FROM printers WHERE id = ?', counter.printer_id) : undefined;
    const lines = this.linesWithNames(order.id);
    const note = kind === 'copy' ? `Reprint by ${by ?? 'staff'}${reason ? ': ' + reason : ''}` : undefined;
    return this.print.createJob({ order, branch, counter, kind, doc: this.print.buildOrderSlip(order, lines, counter, branch, printer, kind, note), createdBy: by, reason });
  }

  private linesWithNames(orderId: string) {
    return this.db.all<Row>(
      `SELECT l.*, i.name_ta FROM order_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.order_id = ? ORDER BY l.sort, l.id`,
      orderId,
    );
  }

  event(order_id: string, actor_type: string, actor_id: string | null, type: string, data: unknown = {}) {
    this.db.run(
      'INSERT INTO order_events (order_id, at, actor_type, actor_id, type, data) VALUES (?,?,?,?,?,?)',
      order_id, nowIso(), actor_type, actor_id, type, JSON.stringify(data),
    );
  }

  byTicket(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return undefined;
    return this.db.get<Row>('SELECT * FROM orders WHERE ticket_token = ?', token);
  }
  byId(id: string) {
    return this.db.get<Row>('SELECT * FROM orders WHERE id = ?', id);
  }

  /** Customer-safe view of an order (served only to the ticket-token holder). */
  ticketView(order: Row) {
    const counter = this.counter(order.counter_id);
    const lines = this.linesWithNames(order.id).filter((l) => l.qty > 0);
    const tot = basketTotal(lines as any);
    return {
      code: order.code,
      status: order.status,
      payment_status: order.payment_status,
      counter: counter ? { number: counter.number, name: counter.name } : null,
      pos_pending: order.pos_status !== 'delivered',
      created_at: order.created_at,
      est_total_paise: tot.paise,
      estimated: tot.estimated,
      final_total_paise: order.final_total_paise,
      receipt_no: order.receipt_no,
      lines: lines.map((l) => ({
        name: l.name_snapshot, name_ta: l.name_ta, pack_label: l.pack_label, sold_by: l.sold_by, qty: l.qty,
        est_grams: l.est_grams, actual_grams: l.actual_grams, unit_price_paise: l.unit_price_paise, amount_paise: lineAmount(l as any).paise,
        source: l.source,
      })),
      is_demo: !!order.is_demo,
    };
  }

  // ---------- POS delivery (worker) ----------
  private posLines(orderId: string): PosLine[] {
    return this.db.all<Row>('SELECT * FROM order_lines WHERE order_id = ? AND qty > 0 ORDER BY sort, id', orderId).map((l) => ({
      line_ref: String(l.id),
      pos_item_id: l.pos_item_id,
      qty: l.qty,
      grams: l.sold_by === 'weight' ? (l.actual_grams ?? l.est_grams ?? null) : null,
      weighed: l.sold_by === 'weight' && l.actual_grams != null,
      unit_price_paise: l.unit_price_paise,
    }));
  }

  async deliverToPos(orderId: string, attempt: number) {
    const order = this.byId(orderId);
    if (!order) return 'done';
    if (order.pos_ref) return 'done';
    if (['cancelled', 'expired'].includes(order.status)) return 'done';
    const counter = this.counter(order.counter_id);
    try {
      // After an uncertain attempt, look up before creating again.
      let posRef: string | null = null;
      if (attempt > 0) posRef = (await this.pos.findHeldBasket(order.id))?.pos_ref ?? null;
      if (!posRef) {
        posRef = (await this.pos.createHeldBasket({
          external_ref: order.id, request_key: `hb-${order.id}`, branch_id: order.branch_id,
          counter_number: counter?.number ?? null, order_code: order.code, lines: this.posLines(order.id),
        })).pos_ref;
      }
      this.db.tx(() => {
        this.db.run(`UPDATE orders SET pos_ref = ?, pos_status = 'delivered', pos_last_error = NULL, updated_at = ? WHERE id = ?`, posRef, nowIso(), order.id);
        this.event(order.id, 'pos', null, 'pos_delivered', { pos_ref: posRef, attempt: attempt + 1 });
        this.db.run(`UPDATE alerts SET resolved_at = ?, resolved_by = 'system' WHERE order_id = ? AND kind = 'pos_failed' AND resolved_at IS NULL`, nowIso(), order.id);
      });
      return 'done';
    } catch (e: any) {
      const msg = e instanceof PosError ? `${e.code}: ${e.message}` : String(e?.message ?? e);
      this.db.run(`UPDATE orders SET pos_last_error = ?, pos_status = 'pending', updated_at = ? WHERE id = ?`, msg, nowIso(), order.id);
      if (attempt === 2) this.print.alert(order.branch_id, 'pos_failed', `Order ${order.code} has not reached the POS yet (${msg}). Retrying automatically.`, { order_id: order.id });
      if (e instanceof PosError && !e.uncertain && e.code === 'UNKNOWN_ITEM') return 'dead';
      return 'retry';
    }
  }

  // ---------- staff: queue & lookup ----------
  queue(branch_id: string) {
    return this.db.all<Row>(
      `SELECT o.*, c.number counter_number, s.display_name claimed_by_name,
        (SELECT count(*) FROM order_lines l WHERE l.order_id = o.id AND l.qty > 0) line_count,
        (SELECT coalesce(sum(CASE WHEN l.sold_by = 'weight' THEN 1 ELSE l.qty END),0) FROM order_lines l WHERE l.order_id = o.id AND l.qty > 0) unit_count,
        (SELECT j.status FROM print_jobs j WHERE j.order_id = o.id AND j.kind IN ('original','copy','transfer') ORDER BY j.created_at DESC LIMIT 1) print_status
       FROM orders o LEFT JOIN counters c ON c.id = o.counter_id LEFT JOIN staff s ON s.id = o.claimed_by
       WHERE o.branch_id = ? AND (o.status IN ${OPEN} OR (o.updated_at > ? ))
       ORDER BY CASE WHEN o.status IN ${OPEN} THEN 0 ELSE 1 END, o.created_at`,
      branch_id, addSeconds(nowIso(), -3600),
    );
  }

  /** Find by short code (today first), slip barcode (SS-YYYYMMDD-CODE) or POS reference. */
  lookup(branchIds: string[] | '*', q: string) {
    const s = q.trim().toUpperCase();
    if (!s) return undefined;
    const scope = branchIds === '*' ? '' : `AND branch_id IN (${branchIds.map(() => '?').join(',')})`;
    const params = branchIds === '*' ? [] : branchIds;
    const bc = parseOrderBarcode(s);
    if (bc) return this.db.get<Row>(`SELECT * FROM orders WHERE business_date = ? AND code = ? ${scope} ORDER BY created_at DESC`, bc.business_date, bc.code, ...params);
    return this.db.get<Row>(
      `SELECT * FROM orders WHERE (code = ? OR pos_ref = ? OR id = ?) ${scope} ORDER BY business_date DESC, created_at DESC LIMIT 1`,
      s, q.trim(), q.trim(), ...params,
    );
  }

  detail(orderId: string) {
    const order = this.byId(orderId);
    if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
    const lines = this.linesWithNames(orderId);
    const events = this.db.all<Row>(
      `SELECT e.*, s.display_name FROM order_events e LEFT JOIN staff s ON s.id = e.actor_id WHERE e.order_id = ? ORDER BY e.id`, orderId);
    const jobs = this.db.all<Row>(`SELECT j.*, s.display_name created_by_name FROM print_jobs j LEFT JOIN staff s ON s.id = j.created_by WHERE j.order_id = ? ORDER BY j.created_at`, orderId);
    const counter = this.counter(order.counter_id);
    const claimer = order.claimed_by ? this.db.get<Row>('SELECT display_name FROM staff WHERE id = ?', order.claimed_by) : undefined;
    const tot = basketTotal(lines.filter((l) => l.qty > 0) as any);
    return { order, lines, events, jobs, counter, claimer, total: tot };
  }

  private requireOpen(order: Row) {
    if (!['awaiting_payment', 'in_progress'].includes(order.status)) throw new HttpError(409, 'CLOSED', `Order is ${order.status.replace('_', ' ')}`);
  }
  private requireHolder(order: Row, staff: Row) {
    this.requireOpen(order);
    if (order.claimed_by !== staff.id) throw new HttpError(409, 'NOT_HOLDER', 'Open this order at your counter first (another cashier may be handling it)');
    if (order.payment_status === 'pending') throw new HttpError(409, 'PAYMENT_PENDING', 'A payment is in progress for this order. Use "Check payment" first.');
  }

  /** Take an order. Only one cashier can hold it; managers can take over with force. */
  claim(orderId: string, staff: Row, force = false) {
    return this.db.tx(() => {
      const order = this.byId(orderId);
      if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
      this.requireOpen(order);
      if (order.claimed_by === staff.id) return order;
      if (order.claimed_by && !force) {
        const who = this.db.get<Row>('SELECT display_name FROM staff WHERE id = ?', order.claimed_by);
        throw new HttpError(409, 'CLAIMED', `${who?.display_name ?? 'Another cashier'} is handling this order`);
      }
      if (force && order.claimed_by && staff.role === 'cashier') throw new HttpError(403, 'FORBIDDEN', 'Ask a manager to take over this order');
      if (order.payment_status === 'pending') throw new HttpError(409, 'PAYMENT_PENDING', 'A payment is in progress for this order');
      const r = this.db.run(
        `UPDATE orders SET claimed_by = ?, claimed_at = ?, status = 'in_progress', updated_at = ? WHERE id = ? AND status IN ${OPEN} AND (claimed_by IS NULL OR claimed_by = ? OR ?)`,
        staff.id, nowIso(), nowIso(), orderId, order.claimed_by, force ? 1 : 0,
      );
      if (!r.changes) throw new HttpError(409, 'CLAIMED', 'Another cashier just opened this order');
      this.event(orderId, 'staff', staff.id, force && order.claimed_by ? 'taken_over' : 'claimed', { from: order.claimed_by });
      return this.byId(orderId)!;
    });
  }

  release(orderId: string, staff: Row, toStaffId?: string) {
    return this.db.tx(() => {
      const order = this.byId(orderId)!;
      this.requireHolder(order, staff);
      if (toStaffId) {
        const to = this.db.get<Row>('SELECT * FROM staff WHERE id = ? AND active = 1', toStaffId);
        if (!to) throw new HttpError(400, 'BAD_STAFF', 'Unknown staff member');
        this.db.run(`UPDATE orders SET claimed_by = ?, claimed_at = ?, updated_at = ? WHERE id = ?`, to.id, nowIso(), nowIso(), orderId);
        this.event(orderId, 'staff', staff.id, 'transferred', { to: to.id, to_name: to.display_name });
      } else {
        this.db.run(`UPDATE orders SET claimed_by = NULL, claimed_at = NULL, status = 'awaiting_payment', updated_at = ? WHERE id = ?`, nowIso(), orderId);
        this.event(orderId, 'staff', staff.id, 'released');
      }
    });
  }

  reassignCounter(orderId: string, staff: Row, counterId: string) {
    const order = this.byId(orderId)!;
    this.requireOpen(order);
    const counter = this.counter(counterId);
    if (!counter || counter.branch_id !== order.branch_id || !counter.active) throw new HttpError(400, 'BAD_COUNTER', 'Choose an active counter in this branch');
    if (counter.id === order.counter_id) return;
    this.db.tx(() => {
      this.db.run('UPDATE orders SET counter_id = ?, updated_at = ? WHERE id = ?', counter.id, nowIso(), orderId);
      this.event(orderId, 'staff', staff.id, 'counter_changed', { from: order.counter_id, to: counter.id, number: counter.number });
      // cancel slips that have not printed yet at the old counter
      this.db.run(`UPDATE print_jobs SET status = 'cancelled', updated_at = ? WHERE order_id = ? AND status = 'queued'`, nowIso(), orderId);
      this.queueSlip(this.byId(orderId)!, 'transfer', staff.id);
    });
  }

  /** Cashier basket edits. Every change is recorded with who/when/before/after. */
  adjust(orderId: string, staff: Row, op: { type: 'set_qty' | 'set_weight' | 'remove' | 'add'; line_id?: number; qty?: number; grams?: number; item_id?: number; barcode?: string }) {
    return this.db.tx(() => {
      const order = this.byId(orderId)!;
      this.requireHolder(order, staff);
      const line = op.line_id ? this.db.get<Row>('SELECT * FROM order_lines WHERE id = ? AND order_id = ?', op.line_id, orderId) : undefined;
      if (op.type !== 'add' && !line) throw new HttpError(404, 'NO_LINE', 'Line not found');
      switch (op.type) {
        case 'set_qty': {
          const qty = Math.floor(Number(op.qty));
          if (!Number.isFinite(qty) || qty < 0 || qty > 999) throw new HttpError(400, 'BAD_QTY', 'Invalid quantity');
          if (line!.sold_by === 'weight') throw new HttpError(400, 'USE_WEIGHT', 'Enter a weight for loose items');
          this.db.run('UPDATE order_lines SET qty = ? WHERE id = ?', qty, line!.id);
          this.event(orderId, 'staff', staff.id, 'line_qty', { line: line!.id, name: line!.name_snapshot, from: line!.qty, to: qty });
          break;
        }
        case 'set_weight': {
          const g = Math.round(Number(op.grams));
          if (line!.sold_by !== 'weight') throw new HttpError(400, 'NOT_WEIGHT', 'This item is not sold by weight');
          if (!Number.isFinite(g) || g < 1 || g > MAX_GRAMS) throw new HttpError(400, 'BAD_WEIGHT', 'Enter the weight in grams (1 - 25000)');
          this.db.run('UPDATE order_lines SET actual_grams = ?, qty = 1 WHERE id = ?', g, line!.id);
          this.event(orderId, 'staff', staff.id, 'line_weighed', { line: line!.id, name: line!.name_snapshot, est_grams: line!.est_grams, from: line!.actual_grams, grams: g });
          break;
        }
        case 'remove': {
          this.db.run('UPDATE order_lines SET qty = 0 WHERE id = ?', line!.id);
          this.event(orderId, 'staff', staff.id, 'line_removed', { line: line!.id, name: line!.name_snapshot, from: line!.qty });
          break;
        }
        case 'add': {
          let item: Item | undefined;
          if (op.barcode) {
            const r = this.catalogue.lookupBarcode(op.barcode, this.scaleRules(this.branch(order.branch_id)!));
            if (r.kind === 'ambiguous') throw new HttpError(409, 'AMBIGUOUS', 'Barcode matches several products - choose one by search', { items: r.items.map((i) => ({ id: i.id, name: i.name_en, pack: i.pack_label })) });
            item = r.items[0];
            if (item && r.kind === 'scale' && (r as any).scale?.weightGrams) op.grams = (r as any).scale.weightGrams;
          } else if (op.item_id) item = this.catalogue.byId(Number(op.item_id));
          if (!item || !item.active) throw new HttpError(404, 'NO_ITEM', 'Product not found');
          const existing = this.db.get<Row>('SELECT * FROM order_lines WHERE order_id = ? AND item_id = ?', orderId, item.id);
          if (item.sold_by === 'weight') {
            const g = op.grams ? Math.round(Number(op.grams)) : null;
            if (existing) {
              this.db.run('UPDATE order_lines SET qty = 1, actual_grams = coalesce(?, actual_grams) WHERE id = ?', g, existing.id);
            } else {
              this.db.run(
                `INSERT INTO order_lines (order_id, item_id, pos_item_id, name_snapshot, pack_label, sold_by, unit_price_paise, submitted_qty, qty, actual_grams, source, sort)
                 VALUES (?,?,?,?,?,?,?,0,1,?,'cashier',999)`, orderId, item.id, item.pos_item_id, item.name_en, item.pack_label, item.sold_by, item.price_paise, g);
            }
          } else {
            const q = Math.max(1, Math.floor(Number(op.qty ?? 1)));
            if (existing) this.db.run('UPDATE order_lines SET qty = qty + ? WHERE id = ?', q, existing.id);
            else this.db.run(
              `INSERT INTO order_lines (order_id, item_id, pos_item_id, name_snapshot, pack_label, sold_by, unit_price_paise, submitted_qty, qty, source, sort)
               VALUES (?,?,?,?,?,?,?,0,?,'cashier',999)`, orderId, item.id, item.pos_item_id, item.name_en, item.pack_label, item.sold_by, item.price_paise, q);
          }
          this.event(orderId, 'staff', staff.id, 'line_added', { item: item.id, name: item.name_en, qty: op.qty ?? 1, grams: op.grams ?? null });
          break;
        }
        default:
          throw new HttpError(400, 'BAD_OP', 'Unknown change');
      }
      this.recalc(orderId);
      return this.detail(orderId);
    });
  }

  private recalc(orderId: string) {
    const lines = this.db.all<Row>('SELECT * FROM order_lines WHERE order_id = ? AND qty > 0', orderId);
    const tot = basketTotal(lines as any);
    const unweighed = lines.some((l) => l.sold_by === 'weight' && l.actual_grams == null);
    this.db.run('UPDATE orders SET est_total_paise = ?, has_unweighed = ?, updated_at = ? WHERE id = ?', tot.paise, unweighed ? 1 : 0, nowIso(), orderId);
  }

  /** Collect payment through the POS. Marked paid only after the POS confirms. */
  async finalize(orderId: string, staff: Row, method: string) {
    if (!['cash', 'upi', 'card', 'other'].includes(method)) throw new HttpError(400, 'BAD_METHOD', 'Choose a payment method');
    const order = this.byId(orderId);
    if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
    if (order.status === 'paid') throw new HttpError(409, 'ALREADY_PAID', `Already paid - receipt ${order.receipt_no}`);
    this.requireHolder(order, staff);
    if (!order.pos_ref) throw new HttpError(409, 'POS_PENDING', 'This basket has not reached the POS yet. Wait a moment or check Reconciliation.');
    const lines = this.db.all<Row>('SELECT * FROM order_lines WHERE order_id = ? AND qty > 0', orderId);
    if (!lines.length) throw new HttpError(409, 'EMPTY', 'The basket is empty - cancel the order instead');
    const unweighed = lines.filter((l) => l.sold_by === 'weight' && l.actual_grams == null);
    if (unweighed.length) throw new HttpError(409, 'NEEDS_WEIGHT', `Weigh first: ${unweighed.map((l) => l.name_snapshot).join(', ')}`);

    const attemptKey = newId('pay');
    const lock = this.db.run(
      `UPDATE orders SET payment_status = 'pending', payment_attempt_key = ?, payment_method = ?, updated_at = ?
       WHERE id = ? AND claimed_by = ? AND status = 'in_progress' AND payment_status IN ('unpaid','failed')`,
      attemptKey, method, nowIso(), orderId, staff.id,
    );
    if (!lock.changes) throw new HttpError(409, 'PAYMENT_LOCKED', 'Payment already in progress or order no longer held by you');
    this.event(orderId, 'staff', staff.id, 'payment_started', { method, attempt: attemptKey });
    try {
      await this.pos.updateHeldBasket(order.pos_ref, this.posLines(orderId)).catch((e) => {
        if (e instanceof PosError && e.code === 'NOT_HELD') return; // finalize below will report the real state
        throw e;
      });
      const sale = await this.pos.finalizeSale({ pos_ref: order.pos_ref, attempt_key: attemptKey, lines: this.posLines(orderId), method: method as any, cashier: staff.username });
      return this.markPaid(orderId, sale, staff.id);
    } catch (e: any) {
      if (e instanceof PosError && e.uncertain) {
        this.event(orderId, 'pos', null, 'payment_uncertain', { attempt: attemptKey, error: e.message });
        throw new HttpError(502, 'PAYMENT_UNCERTAIN', 'The POS did not confirm. Do NOT charge again — press "Check payment".');
      }
      this.db.run(`UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ? AND payment_attempt_key = ?`, nowIso(), orderId, attemptKey);
      this.event(orderId, 'pos', null, 'payment_failed', { attempt: attemptKey, error: e.message });
      throw new HttpError(502, 'PAYMENT_FAILED', `POS rejected the sale: ${e.message}`);
    }
  }

  private markPaid(orderId: string, sale: { receipt_no: string; total_paise: number; sale_id: string; attempt_key: string }, actor: string | null) {
    return this.db.tx(() => {
      const r = this.db.run(
        `UPDATE orders SET status = 'paid', payment_status = 'paid', final_total_paise = ?, receipt_no = ?, paid_at = ?, closed_at = ?, updated_at = ?
         WHERE id = ? AND payment_attempt_key = ? AND status != 'paid'`,
        sale.total_paise, sale.receipt_no, nowIso(), nowIso(), nowIso(), orderId, sale.attempt_key,
      );
      if (r.changes) this.event(orderId, 'pos', actor, 'paid', { receipt_no: sale.receipt_no, sale_id: sale.sale_id, total_paise: sale.total_paise });
      return this.byId(orderId)!;
    });
  }

  /** Resolve an uncertain payment by asking the POS - never by charging again. */
  async checkPayment(orderId: string, actor: string | null) {
    const order = this.byId(orderId);
    if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
    if (order.payment_status !== 'pending' || !order.payment_attempt_key) return { order, result: order.payment_status };
    const sale = await this.pos.lookupSale(order.payment_attempt_key);
    if (sale) return { order: this.markPaid(orderId, sale, actor), result: 'paid' };
    this.db.run(`UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE id = ? AND payment_status = 'pending'`, nowIso(), orderId);
    this.event(orderId, 'pos', actor, 'payment_not_found', { attempt: order.payment_attempt_key });
    return { order: this.byId(orderId)!, result: 'not_found' };
  }

  cancel(orderId: string, staff: Row | null, reason: string, status: 'cancelled' | 'expired' = 'cancelled') {
    return this.db.tx(() => {
      const order = this.byId(orderId)!;
      this.requireOpen(order);
      if (order.payment_status === 'pending') throw new HttpError(409, 'PAYMENT_PENDING', 'Resolve the pending payment first');
      if (staff && order.claimed_by && order.claimed_by !== staff.id && staff.role === 'cashier')
        throw new HttpError(403, 'FORBIDDEN', 'Another cashier is handling this order');
      const ts = nowIso();
      this.db.run(`UPDATE orders SET status = ?, closed_at = ?, updated_at = ?, claimed_by = NULL WHERE id = ?`, status, ts, ts, orderId);
      this.db.run(`UPDATE print_jobs SET status = 'cancelled', updated_at = ? WHERE order_id = ? AND status = 'queued'`, ts, orderId);
      this.db.run(`INSERT OR IGNORE INTO outbox (kind, ref_id, next_attempt_at, created_at) VALUES ('pos_void', ?, ?, ?)`, orderId, ts, ts);
      this.event(orderId, staff ? 'staff' : 'system', staff?.id ?? null, status, { reason });
      return this.byId(orderId)!;
    });
  }

  async voidAtPos(orderId: string) {
    const order = this.byId(orderId);
    if (!order) return 'done';
    if (!order.pos_ref) {
      // It may still arrive from an uncertain attempt; look it up.
      const found = await this.pos.findHeldBasket(order.id);
      if (!found) return 'done';
      this.db.run('UPDATE orders SET pos_ref = ? WHERE id = ?', found.pos_ref, order.id);
      order.pos_ref = found.pos_ref;
    }
    await this.pos.voidHeldBasket(order.pos_ref, order.status);
    this.event(orderId, 'pos', null, 'pos_voided', { pos_ref: order.pos_ref });
    return 'done';
  }

  expireStale() {
    const rows = this.db.all<Row>(
      `SELECT o.id, o.created_at, b.expiry_minutes FROM orders o JOIN branches b ON b.id = o.branch_id
       WHERE o.status = 'awaiting_payment' AND o.payment_status != 'pending'`,
    );
    let n = 0;
    for (const r of rows) {
      if (Date.parse(r.created_at) + r.expiry_minutes * 60000 < Date.now()) {
        try { this.cancel(r.id, null, `Not paid within ${r.expiry_minutes} minutes`, 'expired'); n++; } catch { /* raced */ }
      }
    }
    return n;
  }

  reprint(orderId: string, staff: Row, reason: string) {
    const order = this.byId(orderId);
    if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
    if (!reason?.trim()) throw new HttpError(400, 'REASON', 'Give a reason for the reprint');
    const id = this.queueSlip(order, 'copy', staff.id, reason.trim().slice(0, 200));
    this.event(orderId, 'staff', staff.id, 'reprint_requested', { job: id, reason });
    return id;
  }

  fingerprint(ip: string, ua: string) {
    return hmac(`${ip}|${ua}`).slice(0, 32);
  }
}
