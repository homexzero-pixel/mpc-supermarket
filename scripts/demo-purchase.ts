/**
 * DEMO MODE: runs one complete Scan & Shop purchase end to end against an
 * isolated demo instance (temporary databases, POS simulator, print agent
 * writing slips to files):
 *
 *   entrance QR -> basket -> counter slip -> cashier verification -> paid receipt
 */
import fs from 'node:fs';
import path from 'node:path';
import { startHarness } from '../src/demo/harness.js';
import { LEADING_ZERO_BARCODE } from '../src/demo/seed.js';
import { formatPaise } from '../src/lib/money.js';
import crypto from 'node:crypto';

const out = path.resolve('data/demo-run');
fs.rmSync(out, { recursive: true, force: true });
const h = await startHarness({ dir: out });
const step = (n: number, s: string) => console.log(`\n\x1b[1m${n}. ${s}\x1b[0m`);
try {
  console.log('DEMO MODE — sample catalogue, POS simulator. Nothing here is a real sale.');
  const phone = h.customer('demo-shopper');

  step(1, 'Customer scans the entrance QR');
  const qr = await fetch(`${h.base}/s/main`, { redirect: 'manual' });
  console.log(`   ${h.base}/s/main -> ${qr.status} ${qr.headers.get('location')} (in-store cookie: ${/mpc_instore=main/.test(qr.headers.get('set-cookie') ?? '')})`);

  step(2, 'Customer scans product barcodes and adds loose tomatoes');
  const milk = await (await phone.get(`/api/items/lookup?code=${LEADING_ZERO_BARCODE}&branch=main`)).json() as any;
  console.log(`   scanned ${LEADING_ZERO_BARCODE}: ${milk.kind} -> ${milk.items[0].name} ${milk.items[0].pack} ${formatPaise(milk.items[0].price)}`);
  const rice = h.item('R301');
  const tomato = h.item('V201');
  const lines = [
    { item_id: milk.items[0].id, qty: 2, seen_price_paise: milk.items[0].price, barcode: LEADING_ZERO_BARCODE },
    { item_id: rice.id, qty: 1, seen_price_paise: rice.price_paise },
    { item_id: tomato.id, est_grams: 500, seen_price_paise: tomato.price_paise },
  ];
  console.log(`   basket: 2 x milk 500 ml, 1 x Ponni rice 1 kg, ~500 g tomatoes`);

  step(3, 'Customer taps "Pay at Counter" (and the phone retries once, as on a flaky connection)');
  const key = crypto.randomBytes(16).toString('hex');
  const first = await phone.checkout(lines, key);
  const retry = await phone.checkout(lines, key);
  console.log(`   order ${first.body.code}, ${first.body.counter ? 'Counter ' + first.body.counter.number : 'any counter'} (HTTP ${first.status}); retry returned ${retry.body.code} (replay=${retry.body.replay})`);
  console.log(`   ticket: ${h.base}${first.body.ticket_url}`);

  step(4, 'Server delivers the held basket to the POS; print agent prints the counter slip');
  await h.worker.processOutbox();
  const logs = await h.agentCycle();
  logs.forEach((l) => console.log('   ' + l));
  const order = h.ctx.db.get<any>('SELECT * FROM orders WHERE code = ?', first.body.code);
  console.log(`   POS held basket: ${order.pos_ref}`);
  const slip = h.ctx.db.get<any>(`SELECT preview FROM print_jobs WHERE order_id = ? AND kind = 'original'`, order.id);
  console.log('\n' + slip.preview.split('\n').map((l: string) => '   | ' + l).join('\n'));

  step(5, 'Cashier scans the slip barcode, opens the basket, weighs the tomatoes, adds a missed coconut');
  const cashier = await h.staff('cashier1');
  const found = await cashier.get(`/staff/lookup?q=SS-${order.business_date.replace(/-/g, '')}-${order.code}`);
  console.log(`   slip barcode lookup -> ${found.url.replace(h.base, '')}`);
  await cashier.post(`/staff/orders/${order.id}/claim`);
  const tline = h.ctx.db.get<any>('SELECT id FROM order_lines WHERE order_id = ? AND sold_by = ?', order.id, 'weight');
  await cashier.post(`/staff/orders/${order.id}/adjust`, { type: 'set_weight', line_id: tline.id, grams: 620 });
  const coconut = h.ctx.db.get<any>(`SELECT b.barcode FROM item_barcodes b JOIN items i ON i.id = b.item_id WHERE i.pos_item_id = 'V209'`);
  const adj = await cashier.post(`/staff/orders/${order.id}/adjust`, { type: 'add', barcode: coconut.barcode, qty: 1 });
  console.log(`   tomatoes weighed 620 g; coconut added; running total ${formatPaise(adj.body.total_paise)}`);

  step(6, 'Cashier takes UPI payment through the POS');
  const paid = await cashier.post(`/staff/orders/${order.id}/finalize`, { method: 'upi' });
  console.log(`   POS bill ${paid.body.receipt_no}: ${formatPaise(paid.body.total_paise)} (POS applied its own rounding)`);
  const ticket = await (await phone.get(`/api/tickets/${first.body.token}`)).json() as any;
  console.log(`   customer's ticket now shows: ${ticket.status} · ${formatPaise(ticket.final_total_paise)} · bill ${ticket.receipt_no}`);
  const postings = h.ctx.sim!.postingsFor(order.pos_ref);
  console.log(`   POS recorded ${postings.sales} sale and ${postings.stockMoves} stock movements`);
  console.log(`\nDone. Slip files: ${path.join(out, 'prints')}`);
} finally {
  await h.close();
}
