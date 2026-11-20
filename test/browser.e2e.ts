/**
 * Real-browser shopping trip on a phone-sized screen (Chromium via Playwright).
 * Run: npm run test:e2e   (screenshots go to test-results/)
 * The camera is replaced by a fake BarcodeDetector that keeps "seeing" the same
 * packet, to prove a still camera adds the product exactly once.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { startHarness, type Harness } from '../src/demo/harness.js';
import { LEADING_ZERO_BARCODE } from '../src/demo/seed.js';

const require = createRequire(import.meta.url);
let pw: any;
try {
  pw = require('playwright');
} catch {
  pw = null;
}
const shots = 'test-results';
let h: Harness;
let browser: any;

before(async () => {
  h = await startHarness();
  fs.mkdirSync(shots, { recursive: true });
  if (pw) browser = await pw.chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
});
after(async () => {
  await browser?.close();
  await h.close();
});

test('phone shopping trip: QR -> scan (once) -> search -> loose produce -> Pay at Counter -> ticket', { skip: !pw && 'playwright not installed' }, async () => {
  const ctx = await browser.newContext({ ...pw.devices['Pixel 7'], permissions: ['camera'] });
  // Fake detector: the same packet is in view on every frame. (Plain string so the transpiler leaves it alone.)
  await ctx.addInitScript(`window.BarcodeDetector = class {
      static getSupportedFormats() { return Promise.resolve(['ean_13', 'upc_a']); }
      detect() { return Promise.resolve([{ rawValue: ${JSON.stringify(LEADING_ZERO_BARCODE)} }]); }
    };`);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: any) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(`${h.base}/s/main`);
  await page.waitForSelector('text=Scan a product');
  await page.screenshot({ path: `${shots}/01-branch-home.png` });

  // Scan: camera held still on one packet for ~2 s -> added once
  await page.click('.start-actions [data-open-scanner]');
  await page.waitForSelector('.scan-msg.ok', { timeout: 5000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${shots}/02-scanned.png` });
  let basket = await page.evaluate(() => JSON.parse(localStorage.getItem('mpc.basket.v1')!));
  const milkLine: any = Object.values(basket.lines)[0];
  assert.equal(milkLine.qty, 1, 'still camera adds exactly once');
  assert.equal(milkLine.barcode, LEADING_ZERO_BARCODE);
  // deliberate "Scan another" adds the second identical packet
  await page.click('text=Scan another');
  await page.waitForSelector('.scan-msg.ok');
  await page.waitForTimeout(800);
  basket = await page.evaluate(() => JSON.parse(localStorage.getItem('mpc.basket.v1')!));
  assert.equal((Object.values(basket.lines)[0] as any).qty, 2);
  await page.click('.scanner [aria-label="Close"]');

  // Search with a misspelling and add a pack
  await page.fill('#q-mob', 'ponni');
  await page.press('#q-mob', 'Enter');
  await page.waitForSelector('.product');
  await page.locator('.product').first().locator('[data-add]').click();
  await page.screenshot({ path: `${shots}/03-search.png` });

  // Loose tomatoes: weight sheet
  await page.goto(`${h.base}/b/main/search?q=thakkali`);
  await page.locator('.product').first().locator('[data-add]').click();
  await page.waitForSelector('.sheet');
  await page.screenshot({ path: `${shots}/04-weight-sheet.png` });
  await page.click('.weight-opts button:nth-child(2)'); // 500 g
  await page.waitForSelector('[data-basket-bar]:not([hidden])');
  const bar = await page.textContent('[data-basket-summary]');
  assert.match(bar!, /4 items · ~₹142/);

  await page.click('[data-basket-bar]');
  await page.waitForSelector('[data-submit]');
  await page.waitForFunction(() => document.querySelectorAll('.bline').length === 3);
  await page.screenshot({ path: `${shots}/05-basket.png`, fullPage: true });
  assert.match(await page.textContent('[data-total-label]'), /Estimated total/);

  await page.click('[data-submit]');
  await page.waitForURL(/\/t\//);
  await page.waitForSelector('.ticket-code');
  const code = (await page.textContent('.ticket-code'))!.trim();
  assert.match(code, /^M\d{3}$/);
  assert.match((await page.textContent('.ticket-counter'))!, /Go to Counter\s*\d/);
  await page.screenshot({ path: `${shots}/06-ticket.png` });

  // refresh keeps the ticket
  await page.reload();
  assert.equal((await page.textContent('.ticket-code'))!.trim(), code);
  const o = h.ctx.db.get<any>('SELECT * FROM orders WHERE code = ?', code);
  assert.equal(h.ctx.db.get<any>('SELECT count(*) n FROM order_lines WHERE order_id = ?', o.id).n, 3);

  // cashier pays -> ticket updates live
  await h.worker.processOutbox();
  const cashier = await h.staff('cashier1');
  await cashier.post(`/staff/orders/${o.id}/claim`);
  const tl = h.ctx.db.get<any>(`SELECT id FROM order_lines WHERE order_id = ? AND sold_by = 'weight'`, o.id);
  await cashier.post(`/staff/orders/${o.id}/adjust`, { type: 'set_weight', line_id: tl.id, grams: 480 });
  await cashier.post(`/staff/orders/${o.id}/finalize`, { method: 'cash' });
  await page.waitForSelector('.status-paid', { timeout: 8000 });
  await page.screenshot({ path: `${shots}/07-ticket-paid.png` });

  // Tamil
  await page.goto(`${h.base}/b/main`);
  await page.click('.lang-btn');
  await page.waitForSelector('html[lang="ta"]');
  assert.match(page.url(), /\/b\/main$/, 'language switch stays on the same page');
  assert.equal(await page.isVisible('[data-basket-bar]'), false, 'empty basket bar is hidden');
  await page.screenshot({ path: `${shots}/08-tamil.png` });

  assert.deepEqual(errors, []);
  await ctx.close();
});

test('camera denied -> manual barcode entry still works', { skip: !pw && 'playwright not installed' }, async () => {
  const ctx = await browser.newContext({ ...pw.devices['iPhone 13'] });
  await ctx.addInitScript(`Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });`);
  const page = await ctx.newPage();
  await page.goto(`${h.base}/s/main`);
  await page.click('.start-actions [data-open-scanner]');
  await page.waitForSelector('.no-camera');
  assert.match((await page.textContent('.scan-status'))!, /Camera not available/);
  await page.fill('#manual-code', '2009999910003'); // shared barcode -> must ask which one
  await page.press('#manual-code', 'Enter');
  await page.waitForSelector('text=matches more than one product');
  await page.screenshot({ path: `${shots}/09-ambiguous.png` });
  await page.fill('#manual-code', '2009999999999');
  await page.press('#manual-code', 'Enter');
  await page.waitForSelector('text=Not found');
  await ctx.close();
});

test('desktop: public home, staff queue and order screen render', { skip: !pw && 'playwright not installed' }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(h.base + '/');
  await page.screenshot({ path: `${shots}/10-desktop-home.png`, fullPage: true });
  await page.goto(h.base + '/d/vegetables');
  await page.screenshot({ path: `${shots}/11-desktop-department.png` });

  const r = await h.customer().checkout([{ item_id: h.item('V201').id, est_grams: 1000, seen_price_paise: h.item('V201').price_paise }, { item_id: h.item('M502').id, qty: 2, seen_price_paise: h.item('M502').price_paise }], 'browserdesktoptest0001');
  await h.worker.processOutbox();
  await page.goto(h.base + '/staff/login');
  await page.fill('input[name=username]', 'cashier2');
  await page.fill('input[name=password]', 'mpc-demo-2026');
  await page.click('button:has-text("Sign in")');
  await page.waitForSelector('text=Scan & Shop Orders');
  await page.waitForSelector(`text=${r.body.code}`);
  await page.screenshot({ path: `${shots}/12-staff-queue.png` });
  await page.fill('#lk', r.body.code);
  await page.press('#lk', 'Enter');
  await page.click('text=Open at my counter');
  await page.waitForSelector('text=Take payment');
  await page.screenshot({ path: `${shots}/13-staff-order.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await ctx.close();
});
