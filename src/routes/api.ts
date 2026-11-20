import { Router } from 'express';
import type { AppContext } from '../context.js';
import { HttpError } from '../lib/util.js';
import { rateLimit } from '../lib/ratelimit.js';
import { asyncH, clientIp, langOf, noStore } from './helpers.js';
import { ticketInner } from '../views/shop.js';
import type { Item } from '../catalogue/service.js';
import { config } from '../config.js';

export function publicItem(i: Item) {
  return {
    id: i.id, slug: i.slug, name: i.name_en, name_ta: i.name_ta, brand: i.brand, pack: i.pack_label, sold_by: i.sold_by,
    price: i.price_paise, mrp: i.mrp_paise, max: i.max_qty, available: !!i.available, image: i.image_url || `/img/item/${i.id}.svg`,
  };
}

export function apiRoutes(ctx: AppContext) {
  const r = Router();
  const { catalogue, orders } = ctx;

  const lookupLimit = rateLimit({ windowMs: 60_000, max: 240, key: (req) => 'l:' + clientIp(req) });
  const checkoutLimit = rateLimit({ windowMs: 10 * 60_000, max: config.checkoutRateLimit, key: (req) => 'c:' + clientIp(req), message: 'Too many submissions from this phone. Please wait a few minutes or ask a cashier.' });

  r.use((_req, res, next) => {
    noStore(res);
    next();
  });

  r.get('/items/lookup', lookupLimit, (req, res) => {
    const code = String(req.query.code ?? '').slice(0, 40);
    const branch = req.query.branch ? orders.branchBySlug(String(req.query.branch)) : undefined;
    const result = catalogue.lookupBarcode(code, branch ? orders.scaleRules(branch) : []);
    res.json({ kind: result.kind, code: result.code, items: result.items.map(publicItem), scale: (result as any).scale ?? null });
  });

  r.get('/search', lookupLimit, (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 80);
    const page = Math.max(1, Number(req.query.page) || 1);
    const { items, total } = catalogue.search(q, 20, (page - 1) * 20);
    res.json({ q, total, page, items: items.map(publicItem) });
  });

  /** Re-price a stored basket; tells the customer what changed before they submit. */
  r.post('/basket/quote', lookupLimit, (req, res) => {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines.slice(0, 200) : [];
    if (!lines.length) return res.json({ changes: [], items: [], total: 0, estimated: false });
    const { priced, changes, total } = orders.quote(lines);
    const ids = lines.map((l: any) => Number(l.item_id)).filter(Number.isSafeInteger);
    res.json({ changes, items: catalogue.byIds(ids).map(publicItem), total: total.paise, estimated: total.estimated, lines: priced.length });
  });

  r.get('/b/:slug/status', (req, res) => {
    const b = orders.branchBySlug(String(req.params.slug));
    if (!b) throw new HttpError(404, 'NOT_FOUND', 'Unknown store');
    const lang = langOf(req);
    res.json({ accepting: !!b.accepting_orders, message: b.accepting_orders ? null : (lang === 'ta' ? b.pause_message_ta : b.pause_message_en) || null });
  });

  r.post('/b/:slug/checkout', checkoutLimit, (req, res) => {
    const branch = orders.branchBySlug(String(req.params.slug));
    if (!branch) throw new HttpError(404, 'NOT_FOUND', 'Unknown store');
    const key = String(req.headers['idempotency-key'] ?? req.body?.idempotency_key ?? '');
    const { order, replay } = orders.checkout(branch, { idempotency_key: key, lines: req.body?.lines }, {
      fingerprint: orders.fingerprint(clientIp(req), String(req.headers['user-agent'] ?? '')),
    });
    const counter = orders.counter(order.counter_id);
    res.status(replay ? 200 : 201).json({
      ok: true, replay, code: order.code, token: order.ticket_token, ticket_url: `/t/${order.ticket_token}`,
      counter: counter ? { number: counter.number, name: counter.name } : null,
    });
  });

  r.get('/tickets/:token', (req, res) => {
    const order = orders.byTicket(String(req.params.token));
    if (!order) throw new HttpError(404, 'NOT_FOUND', 'Ticket not found');
    const view = orders.ticketView(order);
    res.json({ ...view, html: ticketInner(langOf(req), view) });
  });

  return r;
}

/** Store print agent protocol: authenticated, outbound-only polling from the counter PC. */
export function agentRoutes(ctx: AppContext) {
  const r = Router();
  r.use((req, _res, next) => {
    const auth = String(req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const agent = token ? ctx.print.agentByToken(token) : undefined;
    if (!agent) return next(new HttpError(401, 'AGENT_AUTH', 'Invalid print agent token'));
    (req as any).agent = agent;
    next();
  });
  r.post('/jobs/claim', (req, res) => {
    const agent = (req as any).agent;
    if (req.body?.status) ctx.print.heartbeat(agent, req.body.status);
    res.json({ jobs: ctx.print.claimJobs(agent, Math.min(10, Number(req.body?.max) || 5)) });
  });
  r.post('/jobs/:id/report', (req, res) => {
    const status = String(req.body?.status);
    if (!['sent', 'printed', 'failed', 'unknown'].includes(status)) throw new HttpError(400, 'BAD_STATUS', 'Invalid status');
    const ok = ctx.print.report((req as any).agent, String(req.params.id), status as any, req.body?.error ? String(req.body.error).slice(0, 300) : undefined);
    if (!ok) throw new HttpError(404, 'NOT_FOUND', 'Job not found for this agent');
    res.json({ ok: true });
  });
  r.post('/heartbeat', (req, res) => {
    ctx.print.heartbeat((req as any).agent, req.body?.status);
    res.json({ ok: true });
  });
  r.get('/config', (req, res) => {
    const agent = (req as any).agent;
    res.json({
      agent: { id: agent.id, name: agent.name, branch_id: agent.branch_id },
      printers: ctx.db.all('SELECT id, name, paper_width_mm, language FROM printers WHERE agent_id = ? AND active = 1', agent.id),
    });
  });
  return r;
}
