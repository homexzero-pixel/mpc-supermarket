import { Router, type Request, type Response } from 'express';
import type { AppContext } from '../context.js';
import { HttpError, nowIso } from '../lib/util.js';
import { assertBranch, canAccessBranch, createSession, destroySession, requireRole, verifyPassword, type StaffUser } from '../lib/auth.js';
import { rateLimit } from '../lib/ratelimit.js';
import { html } from '../lib/html.js';
import { formatPaise } from '../lib/money.js';
import * as SV from '../views/staff.js';
import { asyncH, clientIp, done, flash, noStore, wantsJson } from './helpers.js';
import type { Row } from '../db/index.js';

export function staffRoutes(ctx: AppContext) {
  const r = Router();
  const { db, orders, print, catalogue } = ctx;

  r.use((_req, res, next) => {
    noStore(res);
    next();
  });

  const loginLimit = rateLimit({ windowMs: 15 * 60_000, max: 20, key: (req) => 'login:' + clientIp(req), message: 'Too many sign-in attempts. Wait 15 minutes.' });

  r.get('/staff/login', (req, res) => {
    const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//') ? req.query.next : '/staff';
    res.send(SV.staffLayout({ title: 'Sign in', body: SV.loginPage(next), wide: false }).value);
  });
  r.post('/staff/login', loginLimit, (req, res) => {
    const { username, password } = req.body ?? {};
    const next = typeof req.body?.next === 'string' && req.body.next.startsWith('/') && !req.body.next.startsWith('//') ? req.body.next : '/staff';
    const staff = db.get<Row>('SELECT * FROM staff WHERE username = ? AND active = 1', String(username ?? '').trim().toLowerCase());
    if (!staff || !verifyPassword(String(password ?? ''), staff.password_hash)) {
      db.run('INSERT INTO audit_log (at, staff_id, action, target) VALUES (?,?,?,?)', nowIso(), null, 'login_failed', String(username ?? '').slice(0, 40));
      res.status(401);
      if (wantsJson(req)) return res.json({ ok: false, error: 'Wrong username or password' });
      return res.send(SV.staffLayout({ title: 'Sign in', body: SV.loginPage(next, 'Wrong username or password'), wide: false }).value);
    }
    createSession(db, res, staff);
    db.run('INSERT INTO audit_log (at, staff_id, action) VALUES (?,?,?)', nowIso(), staff.id, 'login');
    done(req, res, next);
  });
  r.post('/staff/logout', requireRole('cashier'), (req, res) => {
    destroySession(db, req, res);
    res.redirect(303, '/staff/login');
  });

  const staffOf = (req: Request) => req.staff as StaffUser;
  function branchFor(req: Request) {
    const s = staffOf(req);
    const wanted = String(req.query.branch ?? req.body?.branch ?? '');
    const all = orders.branches().filter((b) => canAccessBranch(s, b.id));
    if (!all.length) throw new HttpError(403, 'BRANCH', 'No branch assigned to your account');
    return { branch: all.find((b) => b.id === wanted) ?? all[0], branches: all };
  }
  function loadOrder(req: Request) {
    const o = orders.byId(String(req.params.id));
    if (!o) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
    assertBranch(staffOf(req), o.branch_id);
    return o;
  }
  const openAlerts = (branchId: string) => db.all<Row>('SELECT * FROM alerts WHERE branch_id = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 20', branchId);

  /** Run a form action; on error redirect back with the message (or JSON error for fetch). */
  const action = (fn: (req: Request, res: Response) => unknown, back: (req: Request) => string) =>
    asyncH(async (req, res) => {
      try {
        await fn(req, res);
      } catch (e: any) {
        if (wantsJson(req) || !(e instanceof HttpError)) throw e;
        const url = back(req);
        res.redirect(303, `${url}${url.includes('?') ? '&' : '?'}err=${encodeURIComponent(e.message)}`);
      }
    });
  const orderUrl = (req: Request) => `/staff/orders/${req.params.id}`;

  r.get('/staff', requireRole('cashier'), (req, res) => {
    const { branch, branches } = branchFor(req);
    const s = staffOf(req);
    res.send(SV.staffLayout({
      title: 'Orders', staff: s, branch, flash: flash(req), scripts: ['/js/staff.js'],
      body: SV.queuePage({ branch, branches, rows: orders.queue(branch.id), alerts: openAlerts(branch.id), printers: print.printerStatus(branch.id), csrf: s.csrf, staff: s }),
    }).value);
  });

  r.get('/api/staff/feed', requireRole('cashier'), (req, res) => {
    const { branch } = branchFor(req);
    const rows = orders.queue(branch.id);
    const alerts = openAlerts(branch.id);
    res.json({
      queue: SV.queueTable(rows).value,
      alerts: SV.alertsList(alerts, staffOf(req).csrf).value,
      printers: SV.printersStrip(print.printerStatus(branch.id)).value,
      newest: rows.filter((o) => o.status === 'awaiting_payment').map((o) => o.created_at).sort().at(-1) ?? null,
      alert_ids: alerts.map((a) => a.id),
    });
  });

  r.get('/staff/lookup', requireRole('cashier'), (req, res) => {
    const s = staffOf(req);
    const q = String(req.query.q ?? '');
    const o = orders.lookup(s.branchScope, q);
    if (!o) return res.redirect(303, `/staff?branch=${encodeURIComponent(String(req.query.branch ?? ''))}&err=${encodeURIComponent(`No order found for "${q}"`)}`);
    res.redirect(303, `/staff/orders/${o.id}`);
  });

  r.get('/staff/orders/:id', requireRole('cashier'), (req, res) => {
    const o = loadOrder(req);
    const s = staffOf(req);
    const detail = orders.detail(o.id);
    const staffList = db.all<Row>(`SELECT id, display_name, branch_ids FROM staff WHERE active = 1 ORDER BY display_name`).filter((x) => x.branch_ids === '*' || JSON.parse(x.branch_ids).includes(o.branch_id));
    res.send(SV.staffLayout({
      title: `Order ${o.code}`, staff: s, branch: orders.branch(o.branch_id), flash: flash(req), scripts: ['/js/staff.js'],
      body: SV.orderDetailPage({ detail, staff: s, counters: orders.counters(o.branch_id), staffList, csrf: s.csrf }),
    }).value);
  });

  r.post('/staff/orders/:id/claim', requireRole('cashier'), action((req, res) => {
    const o = loadOrder(req);
    orders.claim(o.id, staffOf(req), req.body?.force === '1' || req.body?.force === true);
    done(req, res, orderUrl(req));
  }, orderUrl));

  r.post('/staff/orders/:id/release', requireRole('cashier'), action((req, res) => {
    const o = loadOrder(req);
    const to = String(req.body?.to ?? '');
    if (to) {
      const target = db.get<Row>('SELECT * FROM staff WHERE id = ?', to);
      if (!target || !(target.branch_ids === '*' || JSON.parse(target.branch_ids).includes(o.branch_id))) throw new HttpError(400, 'BAD_STAFF', 'That person is not assigned to this branch');
    }
    orders.release(o.id, staffOf(req), to || undefined);
    done(req, res, to ? orderUrl(req) : `/staff?branch=${o.branch_id}`, {}, to ? 'Order transferred' : 'Order released to the queue');
  }, orderUrl));

  r.post('/staff/orders/:id/counter', requireRole('cashier'), action((req, res) => {
    const o = loadOrder(req);
    orders.reassignCounter(o.id, staffOf(req), String(req.body?.counter_id ?? ''));
    done(req, res, orderUrl(req), {}, 'Counter changed — slip sent to the new counter');
  }, orderUrl));

  r.post('/staff/orders/:id/adjust', requireRole('cashier'), action((req, res) => {
    const o = loadOrder(req);
    const b = req.body ?? {};
    const detail = orders.adjust(o.id, staffOf(req), {
      type: b.type, line_id: b.line_id ? Number(b.line_id) : undefined, qty: b.qty !== undefined && b.qty !== '' ? Number(b.qty) : undefined,
      grams: b.grams !== undefined && b.grams !== '' ? Number(b.grams) : undefined, item_id: b.item_id ? Number(b.item_id) : undefined,
      barcode: b.barcode ? String(b.barcode) : undefined,
    });
    done(req, res, orderUrl(req), { total_paise: detail.total.paise, estimated: detail.total.estimated });
  }, orderUrl));

  r.post('/staff/orders/:id/finalize', requireRole('cashier'), action(async (req, res) => {
    const o = loadOrder(req);
    const paid = await orders.finalize(o.id, staffOf(req), String(req.body?.method ?? ''));
    done(req, res, orderUrl(req), { receipt_no: paid.receipt_no, total_paise: paid.final_total_paise }, `Paid ${formatPaise(paid.final_total_paise)} — POS bill ${paid.receipt_no}`);
  }, orderUrl));

  r.post('/staff/orders/:id/check-payment', requireRole('cashier'), action(async (req, res) => {
    const o = loadOrder(req);
    const { result } = await orders.checkPayment(o.id, staffOf(req).id);
    done(req, res, orderUrl(req), { result }, result === 'paid' ? 'POS confirms the payment — order is paid' : result === 'not_found' ? 'POS has no record of that payment. It is safe to take payment again.' : `Payment status: ${result}`);
  }, orderUrl));

  r.post('/staff/orders/:id/cancel', requireRole('cashier'), action((req, res) => {
    const o = loadOrder(req);
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) throw new HttpError(400, 'REASON', 'Give a reason for cancelling');
    orders.cancel(o.id, staffOf(req), reason.slice(0, 200));
    done(req, res, orderUrl(req), {}, 'Order cancelled — it will not count as a sale');
  }, orderUrl));

  r.post('/staff/orders/:id/reprint', requireRole('cashier'), action((req, res) => {
    const o = loadOrder(req);
    const id = orders.reprint(o.id, staffOf(req), String(req.body?.reason ?? ''));
    db.run('INSERT INTO audit_log (at, staff_id, action, target, data) VALUES (?,?,?,?,?)', nowIso(), staffOf(req).id, 'reprint', o.id, JSON.stringify({ job: id, reason: req.body?.reason }));
    done(req, res, orderUrl(req), { job: id }, 'COPY slip queued');
  }, orderUrl));

  r.post('/staff/print-jobs/:id/retry', requireRole('cashier'), action((req, res) => {
    const job = db.get<Row>('SELECT * FROM print_jobs WHERE id = ?', String(req.params.id));
    if (!job) throw new HttpError(404, 'NOT_FOUND', 'Print job not found');
    assertBranch(staffOf(req), job.branch_id);
    if (!print.retryFailed(job.id)) throw new HttpError(409, 'NOT_RETRYABLE', 'Only failed jobs with a printer can be retried. If the slip may have printed, use Reprint COPY.');
    done(req, res, job.order_id ? `/staff/orders/${job.order_id}` : '/staff', {}, 'Print job re-queued');
  }, (req) => String(req.headers.referer ?? '/staff')));

  r.post('/staff/alerts/:id/resolve', requireRole('cashier'), (req, res) => {
    const a = db.get<Row>('SELECT * FROM alerts WHERE id = ?', Number(req.params.id));
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'Alert not found');
    assertBranch(staffOf(req), a.branch_id);
    db.run('UPDATE alerts SET resolved_at = ?, resolved_by = ? WHERE id = ?', nowIso(), staffOf(req).id, a.id);
    done(req, res, `/staff?branch=${a.branch_id}`);
  });

  r.get('/staff/item-search', requireRole('cashier'), (req, res) => {
    const s = staffOf(req);
    const o = orders.byId(String(req.query.order ?? ''));
    if (!o) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
    assertBranch(s, o.branch_id);
    const q = String(req.query.q ?? '');
    const { items } = catalogue.search(q, 30);
    res.send(SV.staffLayout({
      title: 'Add item', staff: s, wide: false,
      body: html`<p><a href="/staff/orders/${o.id}">← Back to order ${o.code}</a></p><h1>Add to ${o.code}: “${q}”</h1>
        <table class="queue"><tbody>${items.map((i) => html`<tr><td>${i.name_en} <span class="muted">${i.pack_label ?? ''}</span></td><td>${formatPaise(i.price_paise)}${i.sold_by === 'weight' ? '/kg' : ''}</td>
        <td><form method="post" action="/staff/orders/${o.id}/adjust" class="inline"><input type="hidden" name="_csrf" value="${s.csrf}"><input type="hidden" name="type" value="add"><input type="hidden" name="item_id" value="${i.id}">
        ${i.sold_by === 'weight' ? html`<input name="grams" type="number" min="1" max="25000" placeholder="grams" class="qty-in" aria-label="Grams">` : html`<input name="qty" type="number" min="1" max="99" value="1" class="qty-in" aria-label="Quantity">`}
        <button class="btn btn-small btn-primary">Add</button></form></td></tr>`)}</tbody></table>`,
    }).value);
  });

  return r;
}
