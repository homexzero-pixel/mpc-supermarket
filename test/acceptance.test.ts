/**
 * Acceptance scenarios from the brief, run against a real HTTP server, the
 * POS simulator and the real print agent code.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startHarness, type Harness } from '../src/demo/harness.js';
import { addSeconds, nowIso } from '../src/lib/util.js';

const key = () => crypto.randomBytes(16).toString('hex');
let h: Harness;
before(async () => (h = await startHarness()));
after(() => h.close());

function basket(extra: Record<string, unknown>[] = []) {
  const milk = h.item('M501');
  const rice = h.item('R301');
  const tomato = h.item('V201');
  return [
    { item_id: milk.id, qty: 2, seen_price_paise: milk.price_paise },
    { item_id: rice.id, qty: 1, seen_price_paise: rice.price_paise },
    { item_id: tomato.id, est_grams: 500, seen_price_paise: tomato.price_paise },
    ...extra,
  ];
}
const orderByCode = (code: string) => h.ctx.db.get<any>('SELECT * FROM orders WHERE code = ? ORDER BY created_at DESC', code);
const jobsFor = (orderId: string) => h.ctx.db.all<any>('SELECT * FROM print_jobs WHERE order_id = ? ORDER BY created_at', orderId);

describe('Scan & Shop acceptance scenarios', () => {
  test('1. Entrance QR opens the correct branch directly in shopping mode', async () => {
    const r = await fetch(`${h.base}/s/main`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), '/b/main?instore=1');
    assert.match(r.headers.get('set-cookie') ?? '', /mpc_instore=main/);
    const page = await (await fetch(`${h.base}/b/main`, { headers: { cookie: 'mpc_instore=main' } })).text();
    assert.match(page, /class=" in-store"|in-store/);
    assert.match(page, /Scan a product/);
    assert.match(page, /Main Store/);
    assert.equal((await fetch(`${h.base}/s/nowhere`, { redirect: 'manual' })).status, 404);
  });

  test('3. Two packets + loose tomatoes -> one held basket; slip flags tomatoes for weighing', async () => {
    const phone = h.customer();
    const r = await phone.checkout(basket(), key());
    assert.equal(r.status, 201);
    assert.match(r.body.code, /^M\d{3}$/);
    assert.ok(r.body.counter?.number);
    await h.worker.processOutbox();
    const o = orderByCode(r.body.code);
    assert.equal(o.pos_status, 'delivered');
    assert.equal(h.ctx.sim!.db.get<any>('SELECT count(*) n FROM sim_held WHERE external_ref = ?', o.id).n, 1);
    const [job] = jobsFor(o.id);
    assert.equal(job.kind, 'original');
    assert.match(job.preview, /AWAITING PAYMENT/);
    assert.match(job.preview, /WEIGH AT COUNTER/);
    assert.match(job.preview, /ESTIMATED TOTAL/);
    assert.match(job.preview, new RegExp(`COUNTER ${r.body.counter.number}`.split('').join(' ?')));
    const logs = await h.agentCycle();
    assert.match(logs.join('\n'), /printed/);
    assert.equal(jobsFor(o.id)[0].status, 'printed');
  });

  test('4. Double-tap / refresh after timeout -> same order, one held basket, one original print', async () => {
    const phone = h.customer();
    const k = key();
    const [a, b] = await Promise.all([phone.checkout(basket(), k), phone.checkout(basket(), k)]);
    const c = await phone.checkout(basket(), k); // page refreshed and resent
    assert.equal(a.body.code, b.body.code);
    assert.equal(a.body.code, c.body.code);
    assert.equal(a.body.token, c.body.token);
    assert.deepEqual([a.status, b.status].sort(), [200, 201]);
    const o = orderByCode(a.body.code);
    assert.equal(h.ctx.db.get<any>('SELECT count(*) n FROM orders WHERE idempotency_key = ?', k).n, 1);
    await h.worker.processOutbox();
    await h.worker.processOutbox();
    assert.equal(h.ctx.sim!.db.get<any>('SELECT count(*) n FROM sim_held WHERE external_ref = ?', o.id).n, 1);
    assert.equal(jobsFor(o.id).filter((j) => j.kind === 'original').length, 1);
  });

  test('5. Price change during shopping -> customer sees the affected item before submitting', async () => {
    const phone = h.customer();
    const rice = h.item('R301');
    const lines = basket();
    h.ctx.sim!.setPrice('R301', rice.price_paise + 400);
    await h.ctx.catalogue.syncFromPos(h.ctx.pos);
    const quote = await (await fetch(`${h.base}/api/basket/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lines }) })).json() as any;
    assert.equal(quote.changes[0].kind, 'price_changed');
    const k = key();
    const r = await phone.checkout(lines, k);
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'BASKET_CHANGED');
    const ch = r.body.details.changes[0];
    assert.deepEqual([ch.item_id, ch.old_price_paise, ch.new_price_paise], [rice.id, rice.price_paise, rice.price_paise + 400]);
    assert.equal(h.ctx.db.get<any>('SELECT count(*) n FROM orders WHERE idempotency_key = ?', k).n, 0);
    // customer accepts -> resubmits with the new price
    const accepted = lines.map((l) => (l.item_id === rice.id ? { ...l, seen_price_paise: rice.price_paise + 400 } : l));
    const ok = await phone.checkout(accepted, key());
    assert.equal(ok.status, 201);
    h.ctx.sim!.setPrice('R301', rice.price_paise);
    await h.ctx.catalogue.syncFromPos(h.ctx.pos);
  });

  test('6. Printer switched off -> cashier still sees the order, staff alerted, job recoverable', async () => {
    const phone = h.customer();
    const r = await phone.checkout(basket(), key());
    const o = orderByCode(r.body.code);
    await h.agentCycle('fail');
    const [job] = jobsFor(o.id);
    assert.equal(job.status, 'failed');
    assert.match(job.error, /ECONNREFUSED/);
    const alert = h.ctx.db.get<any>('SELECT * FROM alerts WHERE print_job_id = ? AND resolved_at IS NULL', job.id);
    assert.ok(alert, 'staff alert raised');
    const cashier = await h.staff('cashier1');
    const feed = await (await cashier.get('/api/staff/feed')).json() as any;
    assert.ok(feed.queue.includes(o.code), 'order visible on cashier queue');
    assert.ok(feed.queue.includes('PRINT FAILED'));
    assert.ok(feed.alerts.includes('Slip did not print'));
    // printer back on: a definitely-failed ORIGINAL can be safely retried (nothing was printed)
    const retry = await cashier.post(`/staff/print-jobs/${job.id}/retry`);
    assert.equal(retry.status, 200);
    await h.agentCycle();
    assert.equal(jobsFor(o.id)[0].status, 'printed');
    assert.equal(jobsFor(o.id).filter((j) => j.kind === 'original').length, 1);
    assert.ok(h.ctx.db.get<any>('SELECT resolved_at FROM alerts WHERE id = ?', alert.id).resolved_at);
  });

  test('6b. Uncertain print (agent never confirms) -> no automatic reprint; authorised COPY with history', async () => {
    const phone = h.customer();
    const r = await phone.checkout(basket(), key());
    const o = orderByCode(r.body.code);
    const agent = h.ctx.db.get<any>(`SELECT * FROM print_agents WHERE id = 'agt_demo'`);
    h.ctx.print.claimJobs(agent); // agent claimed the job then crashed
    h.ctx.db.run(`UPDATE print_jobs SET lease_expires_at = ? WHERE order_id = ?`, addSeconds(nowIso(), -5), o.id);
    h.ctx.print.expireLeases();
    assert.equal(jobsFor(o.id)[0].status, 'unknown');
    const cashier = await h.staff('cashier1');
    assert.equal((await cashier.post(`/staff/print-jobs/${jobsFor(o.id)[0].id}/retry`)).status, 409, 'uncertain originals are not re-sent');
    const rp = await cashier.post(`/staff/orders/${o.id}/reprint`, { reason: 'Slip not found at counter' });
    assert.equal(rp.status, 200);
    const jobs = jobsFor(o.id);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].kind, 'copy');
    assert.match(jobs[1].preview, /COPY - REPRINT/);
    assert.equal(jobs[1].reason, 'Slip not found at counter');
    assert.ok(h.ctx.db.get('SELECT 1 FROM order_events WHERE order_id = ? AND type = ?', o.id, 'reprint_requested'));
  });

  test('7. POS unreachable then reconnects -> order reaches the POS once, with the original reference', async () => {
    const phone = h.customer();
    h.ctx.sim!.setFault('down');
    const r = await phone.checkout(basket(), key());
    assert.equal(r.status, 201, 'customer still gets an order ticket');
    const o = orderByCode(r.body.code);
    await h.worker.processOutbox();
    assert.equal(orderByCode(r.body.code).pos_status, 'pending');
    const t = await (await phone.get(`/api/tickets/${r.body.token}`)).json() as any;
    assert.equal(t.pos_pending, true);
    assert.equal(jobsFor(o.id).length, 1, 'slip still printed while POS is down');
    // cashier cannot take payment until the POS has the basket
    const cashier = await h.staff('cashier2');
    await cashier.post(`/staff/orders/${o.id}/claim`);
    const pay = await cashier.post(`/staff/orders/${o.id}/finalize`, { method: 'cash' });
    assert.equal(pay.body.code, 'POS_PENDING');
    // POS comes back, but the first reply is lost after it saved the basket (uncertain)
    h.ctx.sim!.setFault('timeout_after_commit', 1);
    h.ctx.db.run(`UPDATE outbox SET next_attempt_at = ? WHERE ref_id = ?`, nowIso(), o.id);
    await h.worker.processOutbox();
    assert.equal(orderByCode(r.body.code).pos_ref, null);
    h.ctx.db.run(`UPDATE outbox SET next_attempt_at = ? WHERE ref_id = ?`, nowIso(), o.id);
    await h.worker.processOutbox();
    const after1 = orderByCode(r.body.code);
    assert.equal(after1.pos_status, 'delivered');
    const held = h.ctx.sim!.db.all<any>('SELECT * FROM sim_held WHERE external_ref = ?', o.id);
    assert.equal(held.length, 1);
    assert.equal(held[0].pos_ref, after1.pos_ref);
    assert.equal(held[0].order_code, o.code);
    h.ctx.sim!.setFault('none');
    await cashier.post(`/staff/orders/${o.id}/release`);
  });

  test('8. Cashier adds a missed item and weighs tomatoes -> POS recalculates; adjustment history kept', async () => {
    const phone = h.customer();
    const r = await phone.checkout(basket(), key());
    await h.worker.processOutbox();
    const o = orderByCode(r.body.code);
    const cashier = await h.staff('cashier1');
    assert.equal((await cashier.post(`/staff/orders/${o.id}/claim`)).status, 200);
    // cannot take payment before weighing
    assert.equal((await cashier.post(`/staff/orders/${o.id}/finalize`, { method: 'cash' })).body.code, 'NEEDS_WEIGHT');
    const tl = h.ctx.db.get<any>(`SELECT * FROM order_lines WHERE order_id = ? AND sold_by = 'weight'`, o.id);
    await cashier.post(`/staff/orders/${o.id}/adjust`, { type: 'set_weight', line_id: tl.id, grams: 620 });
    const coconut = h.item('V209');
    const added = await cashier.post(`/staff/orders/${o.id}/adjust`, { type: 'add', item_id: coconut.id, qty: 1 });
    // 2 x 27 + 68 + 24.80 + 35 = 181.80
    assert.equal(added.body.total_paise, 18180);
    assert.equal(added.body.estimated, false);
    const ml = h.ctx.db.get<any>(`SELECT l.* FROM order_lines l JOIN items i ON i.id = l.item_id WHERE l.order_id = ? AND i.pos_item_id = 'M501'`, o.id);
    await cashier.post(`/staff/orders/${o.id}/adjust`, { type: 'set_qty', line_id: ml.id, qty: 1 }); // customer put one back
    const paid = await cashier.post(`/staff/orders/${o.id}/finalize`, { method: 'upi' });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.total_paise, 15500); // 154.80 -> POS rounds to ₹155
    const events = h.ctx.db.all<any>('SELECT type, actor_id, data FROM order_events WHERE order_id = ? ORDER BY id', o.id).map((e) => e.type);
    for (const t of ['submitted', 'pos_delivered', 'claimed', 'line_weighed', 'line_added', 'line_qty', 'payment_started', 'paid']) assert.ok(events.includes(t), `event ${t}`);
    const lines = h.ctx.db.all<any>('SELECT * FROM order_lines WHERE order_id = ?', o.id);
    const milkLine = lines.find((l) => l.id === ml.id);
    assert.deepEqual([milkLine.submitted_qty, milkLine.qty], [2, 1], 'submitted vs adjusted quantities preserved');
    assert.equal(lines.find((l) => l.source === 'cashier').item_id, coconut.id);
    const t = await (await phone.get(`/api/tickets/${r.body.token}`)).json() as any;
    assert.equal(t.status, 'paid');
    assert.equal(t.final_total_paise, 15500);
  });

  test('9. Two counters try to complete the same order -> one payment, one sale, one inventory posting', async () => {
    const phone = h.customer();
    const r = await phone.checkout(basket().slice(0, 2), key());
    await h.worker.processOutbox();
    const o = orderByCode(r.body.code);
    const c1 = await h.staff('cashier1');
    const c2 = await h.staff('cashier2');
    const [a, b] = await Promise.all([c1.post(`/staff/orders/${o.id}/claim`), c2.post(`/staff/orders/${o.id}/claim`)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const holder = a.status === 200 ? c1 : c2;
    const other = a.status === 200 ? c2 : c1;
    const [p1, p2, p3] = await Promise.all([
      holder.post(`/staff/orders/${o.id}/finalize`, { method: 'cash' }),
      holder.post(`/staff/orders/${o.id}/finalize`, { method: 'cash' }),
      other.post(`/staff/orders/${o.id}/finalize`, { method: 'card' }),
    ]);
    assert.equal([p1, p2, p3].filter((p) => p.status === 200).length, 1);
    assert.equal(h.ctx.sim!.postingsFor(o.pos_ref ?? orderByCode(r.body.code).pos_ref).sales, 1);
    assert.equal(h.ctx.sim!.postingsFor(orderByCode(r.body.code).pos_ref).stockMoves, 2);
    const again = await holder.post(`/staff/orders/${o.id}/finalize`, { method: 'cash' });
    assert.equal(again.body.code, 'ALREADY_PAID');
  });

  test('9b. Payment reply lost -> "Check payment" confirms from POS instead of charging again', async () => {
    const phone = h.customer();
    const r = await phone.checkout(basket().slice(0, 2), key());
    await h.worker.processOutbox();
    const o = orderByCode(r.body.code);
    const c = await h.staff('cashier1');
    await c.post(`/staff/orders/${o.id}/claim`);
    h.ctx.sim!.setFault('timeout_after_commit', 1);
    const p = await c.post(`/staff/orders/${o.id}/finalize`, { method: 'card' });
    assert.equal(p.body.code, 'PAYMENT_UNCERTAIN');
    assert.equal(orderByCode(o.code).payment_status, 'pending');
    const again = await c.post(`/staff/orders/${o.id}/finalize`, { method: 'card' });
    assert.equal(again.status, 409, 'a second charge is blocked while uncertain');
    const chk = await c.post(`/staff/orders/${o.id}/check-payment`);
    assert.equal(chk.body.result, 'paid');
    assert.equal(orderByCode(o.code).status, 'paid');
    assert.equal(h.ctx.sim!.postingsFor(orderByCode(o.code).pos_ref).sales, 1);
  });

  test('10. Customer leaves without paying -> order expires and stays out of sales revenue', async () => {
    const phone = h.customer();
    const r = await phone.checkout(basket(), key());
    await h.worker.processOutbox();
    const o = orderByCode(r.body.code);
    h.ctx.db.run('UPDATE orders SET created_at = ? WHERE id = ?', addSeconds(nowIso(), -3 * 3600), o.id);
    assert.ok(h.ctx.orders.expireStale() >= 1);
    await h.worker.processOutbox();
    assert.equal(orderByCode(o.code).status, 'expired');
    assert.equal(h.ctx.sim!.db.get<any>('SELECT status FROM sim_held WHERE pos_ref = ?', o.pos_ref).status, 'void');
    const mgr = await h.staff('manager');
    const page = await (await mgr.get(`/admin?branch=br_main&filter=closed`)).text();
    assert.ok(page.includes(o.code));
    const sales = h.ctx.db.get<any>(`SELECT coalesce(sum(final_total_paise),0) s FROM orders WHERE status = 'paid'`).s;
    const posSales = h.ctx.sim!.db.get<any>('SELECT coalesce(sum(total_paise),0) s FROM sim_sales').s;
    assert.equal(sales, posSales, 'overview revenue equals POS-confirmed sales only');
    const t = await (await phone.get(`/api/tickets/${r.body.token}`)).json() as any;
    assert.equal(t.status, 'expired');
  });

  test('11. Visitor from Google: product page works without QR or login and explains in-store purchase', async () => {
    const rice = h.item('R302');
    const res = await fetch(`${h.base}/p/${rice.slug}`);
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /Ponni Raw Rice/);
    assert.match(page, /paid and collected at the counter in our store/);
    assert.match(page, /"@type":"Product"/);
    assert.match(page, /InStoreOnly/);
    assert.match(page, /<link rel="canonical" href="[^"]+\/p\//);
    assert.match(page, /Other pack sizes/);
    const sm = await (await fetch(`${h.base}/sitemap.xml`)).text();
    assert.ok(sm.includes(`/p/${rice.slug}`));
    assert.ok(!sm.includes('/basket') && !sm.includes('/t/'));
  });
});

describe('safety & privacy', () => {
  test('paused branch refuses new baskets but accepted baskets keep working', async () => {
    const phone = h.customer();
    const r = await phone.checkout(basket(), key());
    h.ctx.db.run(`UPDATE branches SET accepting_orders = 0, pause_message_en = 'Back at 6 pm' WHERE id = 'br_main'`);
    const blocked = await h.customer().checkout(basket(), key());
    assert.equal(blocked.status, 423);
    assert.equal(blocked.body.error, 'Back at 6 pm');
    const replay = await phone.checkout(basket(), (h.ctx.db.get<any>('SELECT idempotency_key k FROM orders WHERE code = ? ORDER BY created_at DESC', r.body.code)).k);
    assert.equal(replay.status, 200, 'retry of an already accepted basket still works while paused');
    h.ctx.db.run(`UPDATE branches SET accepting_orders = 1 WHERE id = 'br_main'`);
  });

  test('ticket needs the unguessable token; the short code does not expose a basket', async () => {
    const r = await h.customer().checkout(basket(), key());
    assert.ok(r.body.token.length >= 32);
    assert.equal((await fetch(`${h.base}/api/tickets/${r.body.code}`)).status, 404);
    assert.equal((await fetch(`${h.base}/t/${r.body.code}`)).status, 404);
    const t = await fetch(`${h.base}/t/${r.body.token}`);
    assert.equal(t.status, 200);
    assert.match(await t.text(), /noindex/);
    assert.equal(t.headers.get('cache-control'), 'no-store');
  });

  test('server recalculates prices and enforces quantity limits', async () => {
    const rice = h.item('R301');
    const cheat = await h.customer().checkout([{ item_id: rice.id, qty: 1, seen_price_paise: 100 }], key());
    assert.equal(cheat.status, 409);
    const tooMany = await h.customer().checkout([{ item_id: rice.id, qty: 500, seen_price_paise: rice.price_paise }], key());
    assert.equal(tooMany.status, 409);
    assert.equal(tooMany.body.details.changes[0].kind, 'qty_limited');
    const oos = h.item('S703');
    const unavailable = await h.customer().checkout([{ item_id: oos.id, qty: 1, seen_price_paise: oos.price_paise }], key());
    assert.equal(unavailable.body.details.changes[0].kind, 'unavailable');
    assert.equal((await h.customer().checkout([{ item_id: 999999, qty: 1, seen_price_paise: 1 }], key())).status, 409);
    assert.equal((await h.customer().checkout([], key())).status, 400);
    assert.equal((await h.customer().checkout(basket(), 'short')).status, 400);
  });

  test('staff routes require login, role and CSRF; agents need a valid token', async () => {
    assert.equal((await fetch(`${h.base}/staff`, { redirect: 'manual' })).status, 302);
    assert.equal((await fetch(`${h.base}/api/staff/feed`)).status, 401);
    const cashier = await h.staff('cashier1');
    assert.equal((await cashier.get('/admin')).status, 403);
    const noCsrf = await fetch(`${h.base}/admin/staff`, { method: 'POST', headers: { cookie: cashier.cookie, 'content-type': 'application/json', accept: 'application/json' }, body: '{}' });
    assert.equal(noCsrf.status, 403);
    const owner = await h.staff('owner');
    const forged = await fetch(`${h.base}/admin/branches/br_main/accepting`, { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ accepting: '0' }) });
    assert.equal(forged.status, 403);
    assert.equal((await fetch(`${h.base}/api/agent/jobs/claim`, { method: 'POST', headers: { authorization: 'Bearer nope' } })).status, 401);
    const bad = await fetch(`${h.base}/staff/login`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'wrong' }) });
    assert.equal(bad.status, 401);
  });

  test('private pages are not indexable; robots.txt blocks everything until ALLOW_INDEXING', async () => {
    for (const p of ['/basket', '/search?q=rice', '/staff/login']) assert.match(await (await fetch(h.base + p)).text(), /noindex/);
    assert.match(await (await fetch(`${h.base}/robots.txt`)).text(), /Disallow: \//);
  });

  test('counter reassignment prints a transfer slip at the new counter and the ticket follows', async () => {
    const r = await h.customer().checkout(basket(), key());
    const o = orderByCode(r.body.code);
    const other = o.counter_id === 'ctr_1' ? 'ctr_2' : 'ctr_1';
    const mgr = await h.staff('manager');
    assert.equal((await mgr.post(`/staff/orders/${o.id}/counter`, { counter_id: other })).status, 200);
    const jobs = jobsFor(o.id);
    assert.equal(jobs.at(-1).kind, 'transfer');
    assert.equal(jobs.at(-1).counter_id, other);
    const t = await (await fetch(`${h.base}/api/tickets/${r.body.token}`)).json() as any;
    assert.equal(t.counter.number, other === 'ctr_1' ? 1 : 2);
  });
});

describe('owner & manager screens', () => {
  test('every admin page renders and key actions work', async () => {
    const owner = await h.staff('owner');
    for (const p of ['/admin', '/admin?filter=paid', '/admin/reconcile', '/admin/catalogue', '/admin/settings', '/admin/staff', '/admin/demo', '/admin/branches/br_main/sign', '/admin/catalogue/template.csv']) {
      const r = await owner.get(p);
      assert.equal(r.status, 200, p);
    }
    const png = await owner.get('/admin/branches/br_main/qr.png');
    assert.equal(png.headers.get('content-type'), 'image/png');
    const svg = await (await owner.get('/admin/branches/br_main/qr.svg')).text();
    assert.match(svg, /<svg/);
    const sign = await (await owner.get('/admin/branches/br_main/sign')).text();
    assert.match(sign, /Scan to shop · Pick your items · Pay at the counter/);
    // pause / resume
    assert.equal((await owner.post('/admin/branches/br_main/accepting', { accepting: '0', pause_message_en: 'Stock-taking' })).status, 200);
    assert.equal((await h.customer().checkout(basket(), key())).status, 423);
    await owner.post('/admin/branches/br_main/accepting', { accepting: '1' });
    // new print agent token, test slip
    const ag = await owner.post('/admin/branches/br_main/agents', { name: 'Counter PC 2' });
    assert.match(ag.body.token, /^mpcagent_/);
    assert.equal((await owner.post('/admin/printers/prn_c2/test')).status, 200);
    assert.ok(h.ctx.db.get(`SELECT 1 FROM print_jobs WHERE kind = 'test' AND printer_id = 'prn_c2'`));
    // scale rules validated
    assert.equal((await owner.post('/admin/branches/br_main/scale-rules', { rules: '[{"name":"bad"}]' })).status, 400);
    // store details: published only when confirmed, then appear in structured data
    const info = await owner.post('/admin/branches/br_main/store-info', { name_en: 'Main Store', address: '1 Market Road', locality: 'Chennai', phone: '+91 00000 00000', hours: 'Mon-Sun 07:00-22:00', verified: '1' });
    assert.equal(info.status, 200);
    const home = await (await fetch(`${h.base}/`)).text();
    assert.match(home, /"@type":"GroceryStore"/);
    assert.match(home, /1 Market Road/);
    assert.match(home, /"dayOfWeek":\["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"\]/);
    // CSV import through the admin endpoint
    const csv = 'pos_item_id,name_en,department,pack_label,sold_by,price,barcodes\nX1,Test Jaggery,oils-masala,500 g,pack,48.00,2000000000017\nX2,,oils-masala,1 kg,pack,10,\n';
    const imp = await owner.post('/admin/catalogue/import', { csv });
    assert.equal(imp.body.stats.inserted, 1);
    assert.equal(imp.body.stats.skipped, 1);
    // cashier role cannot reach owner tools
    const cashier = await h.staff('cashier2');
    assert.equal((await cashier.post('/admin/staff', { username: 'x' })).status, 403);
  });
});
