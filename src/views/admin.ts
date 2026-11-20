import { html, raw } from '../lib/html.js';
import { formatPaise } from '../lib/money.js';
import { storeClock, storeTime } from '../lib/util.js';
import type { Row } from '../db/index.js';
import { statusBadge, printBadge, printersStrip } from './staff.js';
import { config } from '../config.js';

const hid = (csrf: string) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

function branchPicker(branches: Row[], current: string, extra = '') {
  if (branches.length < 2) return html``;
  return html`<form method="get" class="inline">${raw(extra)}<select name="branch" data-autosubmit aria-label="Branch">${branches.map((b) => html`<option value="${b.id}" ${b.id === current ? raw('selected') : ''}>${b.name_en}</option>`)}</select></form>`;
}

export function overviewPage(d: { branch: Row; branches: Row[]; date: string; stats: any; orders: Row[]; filter: string }) {
  const s = d.stats;
  const tile = (label: string, value: unknown, href?: string) => html`<a class="stat" href="${href ?? '#'}"><span class="stat-v">${value}</span><span class="stat-l">${label}</span></a>`;
  const q = (f: string) => `/admin?branch=${d.branch.id}&date=${d.date}&filter=${f}#orders`;
  return html`
  <div class="toolbar"><h1>Daily overview</h1>${branchPicker(d.branches, d.branch.id, `<input type="hidden" name="date" value="${d.date}">`)}
    <form method="get" class="inline"><input type="hidden" name="branch" value="${d.branch.id}"><label>Date <input type="date" name="date" value="${d.date}" data-autosubmit></label></form></div>
  <div class="stats">
    ${tile('Baskets submitted', s.submitted, q('all'))}
    ${tile('Paid orders', s.paid, q('paid'))}
    ${tile('Sales (POS-confirmed)', formatPaise(s.sales_paise), q('paid'))}
    ${tile('Open now', s.open, q('open'))}
    ${tile('Cancelled / expired', `${s.cancelled} / ${s.expired}`, q('closed'))}
    ${tile('Avg. time to payment', s.avg_minutes == null ? '—' : `${s.avg_minutes} min`, q('paid'))}
    ${tile('Print failures', s.print_failures, q('print'))}
    ${tile('Cashier adjustments', s.adjusted, q('adjusted'))}
  </div>
  <p class="muted small">Sales are counted only from orders the POS confirmed as paid. Cancelled and expired baskets never count as revenue.</p>
  <h2 id="orders">Orders — ${d.filter}</h2>
  <table class="queue"><thead><tr><th>Order</th><th>Submitted</th><th>Status</th><th>Estimated</th><th>Paid</th><th>Receipt</th><th>Method</th></tr></thead><tbody>
  ${d.orders.map((o) => html`<tr><td><a class="code" href="/staff/orders/${o.id}">${o.code}</a></td><td>${storeClock(o.created_at)}</td><td>${statusBadge(o.status)}</td>
    <td>${formatPaise(o.est_total_paise)}</td><td>${o.final_total_paise != null ? formatPaise(o.final_total_paise) : '—'}</td><td>${o.receipt_no ?? '—'}</td><td>${o.payment_method ?? '—'}</td></tr>`)}
  </tbody></table>`;
}

export function reconcilePage(d: { branch: Row; branches: Row[]; missingPos: Row[]; posPaidNotWeb: any[]; printIssues: Row[]; pendingPayments: Row[]; deadOutbox: Row[]; csrf: string; posHealth: { ok: boolean; detail: string } }) {
  const h = hid(d.csrf);
  return html`
  <div class="toolbar"><h1>Reconciliation</h1>${branchPicker(d.branches, d.branch.id)}</div>
  <p class="${d.posHealth.ok ? 'notice ok' : 'notice warn'}">POS connection: ${d.posHealth.ok ? 'OK' : 'PROBLEM'} — ${d.posHealth.detail}</p>
  <section class="card"><h2>Baskets not yet in the POS (${d.missingPos.length})</h2>
    <p class="muted small">Retrying keeps the original order id; the POS is checked for an existing held basket first, so nothing is duplicated.</p>
    <table class="queue"><tbody>${d.missingPos.map((o) => html`<tr><td><a href="/staff/orders/${o.id}">${o.code}</a></td><td>${storeTime(o.created_at)}</td><td>${statusBadge(o.status)}</td><td class="warn-text">${o.pos_last_error ?? 'pending'}</td>
      <td><form method="post" action="/admin/reconcile/retry-pos/${o.id}" class="inline">${h}<button class="btn btn-small">Retry now</button></form></td></tr>`)}</tbody></table>
  </section>
  <section class="card"><h2>Paid in POS, not yet confirmed here (${d.posPaidNotWeb.length})</h2>
    <table class="queue"><tbody>${d.posPaidNotWeb.map((x) => html`<tr><td><a href="/staff/orders/${x.order.id}">${x.order.code}</a></td><td>${x.sale.receipt_no}</td><td>${formatPaise(x.sale.total_paise)}</td>
      <td><form method="post" action="/staff/orders/${x.order.id}/check-payment" class="inline">${h}<button class="btn btn-small">Confirm from POS</button></form></td></tr>`)}</tbody></table>
  </section>
  <section class="card"><h2>Payments awaiting POS confirmation (${d.pendingPayments.length})</h2>
    <table class="queue"><tbody>${d.pendingPayments.map((o) => html`<tr><td><a href="/staff/orders/${o.id}">${o.code}</a></td><td>${o.payment_method}</td><td>${storeClock(o.updated_at)}</td>
      <td><form method="post" action="/staff/orders/${o.id}/check-payment" class="inline">${h}<button class="btn btn-small">Check payment</button></form></td></tr>`)}</tbody></table>
  </section>
  <section class="card"><h2>Print jobs needing attention (${d.printIssues.length})</h2>
    <table class="queue"><tbody>${d.printIssues.map((j) => html`<tr><td>${j.code ? html`<a href="/staff/orders/${j.order_id}">${j.code}</a>` : 'Test'}</td><td>${j.kind}</td><td>${printBadge(j.status)}</td><td class="warn-text">${j.error ?? ''}</td>
      <td>${j.status === 'failed' ? html`<form method="post" action="/staff/print-jobs/${j.id}/retry" class="inline">${h}<button class="btn btn-small">Retry</button></form>` : ''}
      ${j.order_id ? html`<form method="post" action="/staff/orders/${j.order_id}/reprint" class="inline">${h}<input type="hidden" name="reason" value="Reconciliation reprint"><button class="btn btn-small btn-ghost">Reprint COPY</button></form>` : ''}</td></tr>`)}</tbody></table>
  </section>
  ${d.deadOutbox.length ? html`<section class="card"><h2>POS deliveries that need a person (${d.deadOutbox.length})</h2>
    <table class="queue"><tbody>${d.deadOutbox.map((x) => html`<tr><td>${x.kind}</td><td><a href="/staff/orders/${x.ref_id}">${x.ref_id}</a></td><td class="warn-text">${x.last_error ?? ''}</td></tr>`)}</tbody></table></section>` : ''}`;
}

export function cataloguePage(d: { last: Row | undefined; lastOk: Row | undefined; dups: Row[]; review: Row[]; counts: Row; csrf: string; result?: any; posName: string }) {
  const h = hid(d.csrf);
  const lastIssues = d.last ? JSON.parse(d.last.issues || '[]') : [];
  return html`
  <h1>Catalogue</h1>
  <div class="stats">
    <div class="stat"><span class="stat-v">${d.counts.active}</span><span class="stat-l">Active products</span></div>
    <div class="stat"><span class="stat-v">${d.counts.unavailable}</span><span class="stat-l">Unavailable</span></div>
    <div class="stat"><span class="stat-v">${d.dups.length}</span><span class="stat-l">Duplicate barcodes</span></div>
    <div class="stat"><span class="stat-v">${d.lastOk ? storeTime(d.lastOk.finished_at) : 'never'}</span><span class="stat-l">Last successful sync</span></div>
  </div>
  <div class="grid two">
    <section class="card"><h2>Sync from POS</h2><p class="muted">Source: ${d.posName}. Prices, availability and barcodes come from the POS product master.</p>
      <form method="post" action="/admin/catalogue/sync">${h}<button class="btn btn-primary">Sync now</button></form></section>
    <section class="card"><h2>Import CSV</h2>
      <p class="muted small">Columns: pos_item_id, name_en, name_ta, brand, department, pack_label, sold_by (pack|piece|weight), price, mrp, barcodes (separate with |), available, group_key, max_qty, aliases, image_url. Keep barcodes formatted as text so leading zeros survive.</p>
      <form method="post" action="/admin/catalogue/import" enctype="text/plain" data-csv-form>${h}
        <input type="file" accept=".csv,text/csv" data-csv-file required aria-label="CSV file"> <button class="btn">Validate &amp; import</button></form>
      <p><a href="/admin/catalogue/template.csv">Download template</a></p></section>
  </div>
  ${d.result ? html`<section class="card"><h2>Import result</h2><pre>${JSON.stringify(d.result.stats, null, 2)}</pre>
    ${d.result.issues?.length ? html`<ul>${d.result.issues.slice(0, 100).map((i: any) => html`<li>${i.row ? `Row ${i.row}: ` : ''}${i.pos_item_id ? `[${i.pos_item_id}] ` : ''}${i.problem}</li>`)}</ul>` : ''}</section>` : ''}
  ${d.last ? html`<section class="card"><h2>Last sync — ${d.last.source} · ${d.last.status} · ${storeTime(d.last.started_at)}</h2><pre>${d.last.stats}</pre>
    ${lastIssues.length ? html`<details><summary>${lastIssues.length} issue(s)</summary><ul>${lastIssues.map((i: any) => html`<li>${i.row ? `Row ${i.row}: ` : ''}${i.pos_item_id ? `[${i.pos_item_id}] ` : ''}${i.problem}</li>`)}</ul></details>` : ''}</section>` : ''}
  <section class="card"><h2>Duplicate barcodes (${d.dups.length})</h2><p class="muted small">Customers scanning these are asked to choose — fix them in the POS.</p>
    <ul>${d.dups.map((x) => html`<li><code>${x.barcode}</code> — ${x.names}</li>`)}</ul></section>
  <section class="card"><h2>Products needing review (${d.review.length})</h2>
    <table class="queue"><tbody>${d.review.map((i) => html`<tr><td>${i.pos_item_id}</td><td><a href="/p/${i.slug}">${i.name_en}</a> ${i.pack_label ?? ''}</td><td>${i.problem}</td></tr>`)}</tbody></table></section>`;
}

export function settingsPage(d: { branch: Row; branches: Row[]; counters: Row[]; printers: Row[]; agents: Row[]; printerStatus: Row[]; csrf: string; newAgentToken?: string; qrSvg: string; qrUrl: string; canEdit: boolean; recentJobs: Row[] }) {
  const h = hid(d.csrf);
  const b = d.branch;
  const info = JSON.parse(b.store_info || '{}');
  return html`
  <div class="toolbar"><h1>Settings — ${b.name_en}</h1>${branchPicker(d.branches, b.id)}</div>
  ${d.newAgentToken ? html`<div class="notice ok" role="alert"><strong>Print agent token (shown once — copy it now):</strong><br><code class="token">${d.newAgentToken}</code></div>` : ''}

  <section class="card"><h2>Scan &amp; Shop status</h2>
    <form method="post" action="/admin/branches/${b.id}/accepting" class="stack">${h}
      <p>New submissions are currently <strong>${b.accepting_orders ? 'OPEN' : 'PAUSED'}</strong>. Pausing never affects baskets already accepted.</p>
      <label>Message shown to customers while paused (English) <input name="pause_message_en" value="${b.pause_message_en ?? ''}" placeholder="Scan & Shop is paused. Please bill at any counter."></label>
      <label>Message (Tamil) <input name="pause_message_ta" value="${b.pause_message_ta ?? ''}" lang="ta"></label>
      <button class="btn ${b.accepting_orders ? 'btn-danger' : 'btn-primary'}" name="accepting" value="${b.accepting_orders ? '0' : '1'}">${b.accepting_orders ? 'Pause new submissions' : 'Resume Scan & Shop'}</button>
    </form></section>

  <section class="card"><h2>Entrance QR code</h2>
    <div class="qr-row"><div class="qr">${raw(d.qrSvg)}</div>
      <div><p>Links to <code>${d.qrUrl}</code>. This address never changes, so counters and printers can be changed without reprinting the QR.</p>
      <p><a class="btn" href="/admin/branches/${b.id}/qr.svg" download>Download QR (SVG)</a> <a class="btn" href="/admin/branches/${b.id}/qr.png" download>Download QR (PNG)</a> <a class="btn btn-primary" href="/admin/branches/${b.id}/sign" target="_blank">Printable entrance sign</a></p></div></div></section>

  <section class="card"><h2>Counters &amp; routing</h2>
    <form method="post" action="/admin/branches/${b.id}/routing" class="inline">${h}
      <label>New baskets go to <select name="routing">
        ${[['default', 'Default counter'], ['least_busy', 'Least busy counter'], ['round_robin', 'Take turns (round robin)']].map(([v, l]) => html`<option value="${v}" ${b.routing === v ? raw('selected') : ''}>${l}</option>`)}
      </select></label>
      <label>Default <select name="default_counter_id">${d.counters.map((c) => html`<option value="${c.id}" ${c.id === b.default_counter_id ? raw('selected') : ''}>Counter ${c.number}</option>`)}</select></label>
      <label>Expire unpaid after <input type="number" name="expiry_minutes" min="15" max="720" value="${b.expiry_minutes}" class="qty-in"> min</label>
      <label>Max open baskets <input type="number" name="max_open_orders" min="1" max="500" value="${b.max_open_orders}" class="qty-in"></label>
      <button class="btn">Save</button></form>
    <table class="queue"><thead><tr><th>Counter</th><th>Active</th><th>Printer</th><th></th></tr></thead><tbody>
    ${d.counters.map((c) => html`<tr><td>Counter ${c.number} <small class="muted">${c.name}</small></td>
      <td colspan="3"><form method="post" action="/admin/counters/${c.id}" class="inline">${h}
        <label><input type="checkbox" name="active" value="1" ${c.active ? raw('checked') : ''}> active</label>
        <select name="printer_id" aria-label="Printer"><option value="">— no printer —</option>${d.printers.map((p) => html`<option value="${p.id}" ${p.id === c.printer_id ? raw('selected') : ''}>${p.name}</option>`)}</select>
        <button class="btn btn-small">Save</button></form></td></tr>`)}
    </tbody></table>
    <form method="post" action="/admin/branches/${b.id}/counters" class="inline">${h}<label>Add counter number <input type="number" name="number" min="1" max="99" class="qty-in" required></label><button class="btn btn-small">Add</button></form>
  </section>

  <section class="card"><h2>Printers</h2>
    ${printersStrip(d.printerStatus)}
    <table class="queue"><thead><tr><th>Printer</th><th>Settings</th><th></th></tr></thead><tbody>
    ${d.printers.map((p) => html`<tr><td><strong>${p.name}</strong><br><small class="muted">${p.id}</small></td><td>
      <form method="post" action="/admin/printers/${p.id}" class="inline">${h}
        <label>Paper <select name="paper_width_mm"><option value="80" ${p.paper_width_mm === 80 ? raw('selected') : ''}>80 mm</option><option value="58" ${p.paper_width_mm === 58 ? raw('selected') : ''}>58 mm</option></select></label>
        <label>Slip language <select name="language"><option value="en" ${p.language === 'en' ? raw('selected') : ''}>English</option><option value="ta" ${p.language === 'ta' ? raw('selected') : ''}>Tamil (raster agent)</option></select></label>
        <label>Served by agent <select name="agent_id"><option value="">—</option>${d.agents.map((a) => html`<option value="${a.id}" ${a.id === p.agent_id ? raw('selected') : ''}>${a.name}</option>`)}</select></label>
        <button class="btn btn-small">Save</button></form></td>
      <td><form method="post" action="/admin/printers/${p.id}/test" class="inline">${h}<button class="btn btn-small btn-primary">Print test slip</button></form></td></tr>`)}
    </tbody></table>
    <form method="post" action="/admin/branches/${b.id}/printers" class="inline">${h}<label>Add printer named <input name="name" required placeholder="Counter 1 thermal"></label><button class="btn btn-small">Add</button></form>
  </section>

  <section class="card"><h2>Store print agents</h2>
    <p class="muted small">The agent runs on the counter computer, connects OUT to this server, fetches jobs for its printers and sends them to the thermal printer. See docs/PRINT_AGENT.md.</p>
    <ul>${d.agents.map((a) => html`<li><strong>${a.name}</strong> (${a.id}) — last seen ${a.last_seen_at ? storeTime(a.last_seen_at) : 'never'}
      <form method="post" action="/admin/agents/${a.id}/rotate" class="inline">${h}<button class="btn btn-small btn-ghost">New token</button></form></li>`)}</ul>
    <form method="post" action="/admin/branches/${b.id}/agents" class="inline">${h}<label>New agent name <input name="name" required placeholder="Counter PC 1"></label><button class="btn btn-small">Create &amp; show token</button></form>
  </section>

  <section class="card"><h2>Recent print jobs</h2>
    <table class="queue"><tbody>${d.recentJobs.map((j) => html`<tr><td>${storeClock(j.created_at)}</td><td>${j.kind}</td><td>${j.code ?? ''}</td><td>${printBadge(j.status)}</td><td><details><summary>Preview</summary><pre class="slip">${j.preview}</pre></details></td></tr>`)}</tbody></table>
  </section>

  <section class="card"><h2>Scale-label barcodes</h2>
    <p class="muted small">Leave empty until you have photographed sample labels from the store's scale. Some scales encode weight, others price. Example rule for "21 PPPPP WWWWW C" (weight in grams): <code>[{"name":"Scale weight","prefixes":["21"],"length":13,"itemStart":2,"itemLength":5,"valueStart":7,"valueLength":5,"valueType":"weight_g"}]</code>. Map PLUs by giving products a barcode of <code>plu:00123</code>.</p>
    <form method="post" action="/admin/branches/${b.id}/scale-rules" class="stack">${h}<textarea name="rules" rows="5" spellcheck="false">${b.scale_label_rules}</textarea><button class="btn btn-small">Save rules</button></form>
  </section>

  <section class="card"><h2>Store details (public)</h2>
    <p class="muted small">Only publish details the owner has confirmed. They appear on the website, in Google structured data, and must match your Google Business Profile exactly.</p>
    <form method="post" action="/admin/branches/${b.id}/store-info" class="stack">${h}
      <label>Branch name (English) <input name="name_en" value="${b.name_en}" required></label>
      <label>Branch name (Tamil) <input name="name_ta" value="${b.name_ta ?? ''}" lang="ta"></label>
      <label>Street address <input name="address" value="${info.address ?? ''}"></label>
      <label>Locality / city <input name="locality" value="${info.locality ?? ''}"></label>
      <label>PIN code <input name="postal_code" value="${info.postal_code ?? ''}" inputmode="numeric"></label>
      <label>Phone <input name="phone" value="${info.phone ?? ''}" inputmode="tel"></label>
      <label>Opening hours (one per line: <code>Mon-Sun 07:00-22:00</code>) <textarea name="hours" rows="3">${(info.hours ?? []).map((x: any) => `${x.days} ${x.open}-${x.close}`).join('\n')}</textarea></label>
      <label>Google Maps link <input name="map_url" value="${info.map_url ?? ''}" type="url"></label>
      <label>Latitude <input name="lat" value="${info.geo?.lat ?? ''}"></label><label>Longitude <input name="lng" value="${info.geo?.lng ?? ''}"></label>
      <label class="check"><input type="checkbox" name="verified" value="1" ${info.verified ? raw('checked') : ''}> These details are confirmed by the owner — publish them</label>
      <button class="btn btn-primary">Save store details</button></form>
  </section>`;
}

export function signPage(d: { branch: Row; qrSvg: string; url: string }) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Entrance sign — ${d.branch.name_en}</title><meta name="robots" content="noindex">
  <link rel="stylesheet" href="/css/app.css"><script src="/js/staff.js" defer></script><style>
  @page{size:A4;margin:12mm} body{background:#fff} .sign{max-width:180mm;margin:0 auto;text-align:center;font-family:Poppins,sans-serif;color:#0B5A2A;padding:10mm;border:3mm solid #0B5A2A;border-radius:8mm}
  .sign img.logo{width:110mm;height:auto}.sign h1{font-size:15mm;margin:4mm 0;line-height:1.1}.sign .ta{font-family:'Noto Sans Tamil',sans-serif;font-size:7mm;margin:0 0 6mm}
  .sign .qr svg{width:95mm;height:95mm}.sign .steps{font-size:8mm;font-weight:600;margin:6mm 0 2mm}.sign .ta2{font-family:'Noto Sans Tamil',sans-serif;font-size:5.5mm;margin:0}
  .sign .url{font-size:4mm;color:#333;margin-top:5mm}@media screen{body{padding:20px}.print-btn{display:block;margin:0 auto 16px}}@media print{.print-btn{display:none}}</style></head>
  <body><button class="btn btn-primary print-btn" data-print>Print this sign</button>
  <div class="sign"><img class="logo" src="/brand/mpc-logo-480.png" alt="MPC"><h1>Scan &amp; Shop</h1>
  <p class="ta">${d.branch.name_ta ?? ''}${d.branch.name_ta ? ' · ' : ''}${d.branch.name_en}</p>
  <div class="qr">${raw(d.qrSvg)}</div>
  <p class="steps">Scan to shop · Pick your items · Pay at the counter</p>
  <p class="ta2">ஸ்கேன் செய்யுங்கள் · பொருட்களை எடுங்கள் · கவுண்டரில் பணம் செலுத்துங்கள்</p>
  <p class="url">${d.url}</p></div></body></html>`;
}

export function staffAdminPage(d: { staff: Row[]; branches: Row[]; csrf: string }) {
  const h = hid(d.csrf);
  return html`<h1>Staff accounts</h1>
  <table class="queue"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Branches</th><th>Active</th><th></th></tr></thead><tbody>
  ${d.staff.map((s) => html`<tr><td>${s.display_name}</td><td>${s.username}</td><td>${s.role}</td><td>${s.branch_ids === '*' ? 'All' : JSON.parse(s.branch_ids).join(', ')}</td><td>${s.active ? 'Yes' : 'No'}</td>
    <td><form method="post" action="/admin/staff/${s.id}/toggle" class="inline">${h}<button class="btn btn-small btn-ghost">${s.active ? 'Disable' : 'Enable'}</button></form>
    <form method="post" action="/admin/staff/${s.id}/password" class="inline">${h}<input name="password" type="password" minlength="8" placeholder="new password" required aria-label="New password"><button class="btn btn-small">Set password</button></form></td></tr>`)}
  </tbody></table>
  <section class="card"><h2>Add staff member</h2>
  <form method="post" action="/admin/staff" class="stack">${h}
    <label>Display name <input name="display_name" required></label><label>Username <input name="username" required pattern="[a-z0-9._-]{3,32}"></label>
    <label>Password (min 8) <input name="password" type="password" minlength="8" required></label>
    <label>Role <select name="role"><option value="cashier">Cashier</option><option value="manager">Manager</option><option value="owner">Owner</option></select></label>
    <label>Branch <select name="branch"><option value="*">All branches</option>${d.branches.map((b) => html`<option value="${b.id}">${b.name_en}</option>`)}</select></label>
    <button class="btn btn-primary">Create</button></form></section>`;
}

export function demoPage(d: { csrf: string; fault: string; items: Row[]; branch: Row }) {
  const h = hid(d.csrf);
  return html`<h1>Demo tools</h1>
  <p class="muted">Only available in DEMO MODE. Use these to rehearse failures before going live.</p>
  <section class="card"><h2>POS simulator faults</h2><p>Current: <strong>${d.fault}</strong></p>
    <form method="post" action="/admin/demo/fault" class="inline">${h}
      <button class="btn" name="fault" value="none">Healthy</button>
      <button class="btn" name="fault" value="down">POS unreachable</button>
      <button class="btn" name="fault" value="timeout_after_commit">Next call times out after saving</button></form></section>
  <section class="card"><h2>Change a price at the POS</h2>
    <form method="post" action="/admin/demo/price" class="inline">${h}
      <select name="pos_item_id" aria-label="Item">${d.items.map((i) => html`<option value="${i.pos_item_id}">${i.name_en} ${i.pack_label ?? ''} — ${formatPaise(i.price_paise)}</option>`)}</select>
      <label>New price ₹ <input name="price" required inputmode="decimal" class="qty-in"></label><button class="btn">Change &amp; sync</button></form></section>
  <section class="card"><h2>Walk through a full purchase</h2>
    <ol><li>Open <a href="/s/${d.branch.slug}" target="_blank">the entrance QR link</a> on a phone (or narrow browser window).</li>
    <li>Scan or search products, add a few, add loose tomatoes, then <em>Pay at Counter</em>.</li>
    <li>Run the print agent in demo mode (<code>npm run demo</code> starts it) — slips appear in <code>data/sim-prints/</code> and under Settings → Recent print jobs.</li>
    <li>On <a href="/staff">Orders</a>, open the basket, weigh the tomatoes, take payment.</li></ol>
    <p>Or run <code>npm run demo:run</code> to perform the whole journey automatically.</p></section>
  ${config.demoMode ? '' : ''}`;
}
