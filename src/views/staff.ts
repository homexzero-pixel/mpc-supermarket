import { html, raw, type SafeHtml } from '../lib/html.js';
import { formatGrams, formatPaise, lineAmount } from '../lib/money.js';
import { minutesSince, storeClock, storeTime } from '../lib/util.js';
import { hasRole, type StaffUser } from '../lib/auth.js';
import type { Row } from '../db/index.js';
import { config } from '../config.js';
import { ASSET_VERSION } from './layout.js';

export function staffLayout(o: { title: string; staff?: StaffUser; body: SafeHtml; branch?: Row; flash?: { err?: string; ok?: string }; scripts?: string[]; wide?: boolean }) {
  const s = o.staff;
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title} · MPC Staff</title><meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/favicon.png"><link rel="stylesheet" href="/css/app.css?v=${ASSET_VERSION}"><link rel="stylesheet" href="/css/staff.css?v=${ASSET_VERSION}">
</head><body class="staff">
${config.demoMode ? html`<div class="demo-banner">DEMO MODE — POS simulator and sample catalogue. Nothing here is a real sale.</div>` : ''}
<header class="staff-header"><div class="wrap-wide header-row">
  <a class="brand" href="/staff"><img src="/brand/mpc-logo-480.webp" alt="MPC" width="96" height="35"><span class="branch-tag">Scan &amp; Shop${o.branch ? ' · ' + o.branch.name_en : ''}</span></a>
  ${s ? html`<nav class="staff-nav" aria-label="Staff">
    <a href="/staff">Orders</a>
    ${hasRole(s, 'manager') ? html`<a href="/admin">Overview</a><a href="/admin/reconcile">Reconcile</a><a href="/admin/catalogue">Catalogue</a><a href="/admin/settings">Settings</a>` : ''}
    ${hasRole(s, 'owner') ? html`<a href="/admin/staff">Staff</a>` : ''}
    ${config.demoMode && hasRole(s, 'manager') ? html`<a href="/admin/demo">Demo tools</a>` : ''}
    <form method="post" action="/staff/logout" class="inline"><input type="hidden" name="_csrf" value="${s.csrf}"><button class="chip">${s.display_name} · Sign out</button></form>
  </nav>` : ''}
</div></header>
<main id="main" class="${o.wide === false ? 'wrap' : 'wrap-wide'}">
${o.flash?.err ? html`<div class="notice warn" role="alert">${o.flash.err}</div>` : ''}
${o.flash?.ok ? html`<div class="notice ok" role="status">${o.flash.ok}</div>` : ''}
${o.body}
</main>
${s ? html`<meta name="csrf-token" content="${s.csrf}">` : ''}
${(o.scripts ?? []).map((x) => html`<script src="${x}?v=${ASSET_VERSION}" defer></script>`)}
</body></html>`;
}

export function loginPage(next: string, error?: string) {
  return html`<section class="login card">
    <h1>Staff sign-in</h1>
    ${error ? html`<p class="notice warn" role="alert">${error}</p>` : ''}
    <form method="post" action="/staff/login">
      <input type="hidden" name="next" value="${next}">
      <label>Username <input name="username" autocomplete="username" required autofocus></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn btn-primary btn-block">Sign in</button>
    </form>
  </section>`;
}

export const STATUS_LABEL: Record<string, string> = {
  awaiting_payment: 'Waiting', in_progress: 'At counter', paid: 'Paid', cancelled: 'Cancelled', expired: 'Expired',
};
export const PRINT_LABEL: Record<string, string> = {
  queued: 'Print queued', claimed: 'Printing…', sent: 'Sent to printer', printed: 'Printed', failed: 'PRINT FAILED', unknown: 'Print unconfirmed', cancelled: 'Print cancelled',
};

export function statusBadge(s: string) {
  return html`<span class="badge-s s-${s}">${STATUS_LABEL[s] ?? s}</span>`;
}
export function printBadge(s?: string | null) {
  if (!s) return html`<span class="badge-s p-none">No slip</span>`;
  return html`<span class="badge-s p-${s}">${PRINT_LABEL[s] ?? s}</span>`;
}

export function queueTable(rows: Row[]) {
  if (!rows.length) return html`<p class="empty">No Scan &amp; Shop baskets right now.</p>`;
  return html`<table class="queue"><thead><tr><th>Order</th><th>Counter</th><th>Waiting</th><th>Items</th><th>Total</th><th>Status</th><th>Slip</th><th>POS</th><th></th></tr></thead><tbody>
  ${rows.map((o) => html`<tr class="row-${o.status}${o.has_unweighed ? ' needs-weigh' : ''}">
    <td><a class="code" href="/staff/orders/${o.id}">${o.code}</a></td>
    <td>${o.counter_number ?? '—'}</td>
    <td>${['awaiting_payment', 'in_progress'].includes(o.status) ? `${minutesSince(o.created_at)} min` : storeClock(o.updated_at)}</td>
    <td>${o.line_count} lines / ${o.unit_count} units${o.has_unweighed ? html` <span class="badge-s s-weigh">Weigh</span>` : ''}</td>
    <td>${o.status === 'paid' ? formatPaise(o.final_total_paise) : html`${o.has_unweighed ? '~' : ''}${formatPaise(o.est_total_paise)}`}</td>
    <td>${statusBadge(o.status)}${o.claimed_by_name ? html`<br><small>${o.claimed_by_name}</small>` : ''}${o.payment_status === 'pending' ? html`<br><span class="badge-s p-unknown">Payment pending</span>` : ''}</td>
    <td>${printBadge(o.print_status)}</td>
    <td>${o.pos_status === 'delivered' ? html`<span class="badge-s p-sent">${o.pos_ref}</span>` : html`<span class="badge-s p-unknown">Not in POS yet</span>`}</td>
    <td><a class="btn btn-small" href="/staff/orders/${o.id}">Open</a></td>
  </tr>`)}
  </tbody></table>`;
}

export function alertsList(alerts: Row[], csrf: string) {
  if (!alerts.length) return html``;
  return html`<section class="alerts" aria-label="Alerts" role="alert">
    ${alerts.map((a) => html`<div class="alert-row k-${a.kind}"><span>⚠ ${a.message}</span>
      <span class="muted small">${storeClock(a.created_at)}</span>
      ${a.order_id ? html`<a class="btn btn-small" href="/staff/orders/${a.order_id}">Open order</a>` : ''}
      <form method="post" action="/staff/alerts/${a.id}/resolve" class="inline"><input type="hidden" name="_csrf" value="${csrf}"><button class="btn btn-small btn-ghost">Dismiss</button></form></div>`)}
  </section>`;
}

export function printersStrip(printers: Row[]) {
  if (!printers.length) return html`<p class="notice warn">No printer configured for this branch. Slips cannot print — set one up in Settings.</p>`;
  return html`<div class="printer-strip">${printers.map((p) => {
    const ok = p.agent_online && (!p.printer_state || p.printer_state.state === 'ok');
    return html`<span class="printer ${ok ? 'ok' : 'bad'}" title="${p.printer_state?.detail ?? ''}">${ok ? '●' : '▲'} ${p.name}: ${!p.agent_id ? 'no print agent' : !p.agent_online ? `agent offline (${isFinite(p.seconds_since_seen) ? p.seconds_since_seen + 's' : 'never seen'})` : p.printer_state?.state && p.printer_state.state !== 'ok' ? p.printer_state.detail ?? p.printer_state.state : 'ready'}${p.pending ? ` · ${p.pending} pending` : ''}${p.problems ? ` · ${p.problems} problem(s)` : ''}</span>`;
  })}</div>`;
}

export function queuePage(d: { branch: Row; branches: Row[]; rows: Row[]; alerts: Row[]; printers: Row[]; csrf: string; staff: StaffUser }) {
  return html`
  <div class="toolbar">
    <h1>Scan &amp; Shop Orders</h1>
    ${d.branches.length > 1 ? html`<form method="get" class="inline"><select name="branch" data-autosubmit aria-label="Branch">${d.branches.map((b) => html`<option value="${b.id}" ${b.id === d.branch.id ? raw('selected') : ''}>${b.name_en}</option>`)}</select></form>` : ''}
    <form method="get" action="/staff/lookup" class="lookup" role="search">
      <input type="hidden" name="branch" value="${d.branch.id}">
      <label class="sr-only" for="lk">Order code, slip barcode or POS ref</label>
      <input id="lk" name="q" placeholder="Scan slip or type code (e.g. M042)" autocomplete="off" autofocus>
      <button class="btn btn-primary">Open</button>
    </form>
  </div>
  ${!d.branch.accepting_orders ? html`<p class="notice warn">New Scan &amp; Shop submissions are PAUSED for this branch. Accepted baskets can still be processed.</p>` : ''}
  <div data-feed="${d.branch.id}">
    <div data-printers>${printersStrip(d.printers)}</div>
    <div data-alerts>${alertsList(d.alerts, d.csrf)}</div>
    <div data-queue>${queueTable(d.rows)}</div>
  </div>
  <p class="muted small">Updates automatically. A sound plays for new baskets and print problems (click anywhere once to enable sound).</p>`;
}

function lineRow(o: Row, l: Row, editable: boolean, csrf: string) {
  const amt = lineAmount(l as any);
  const changed = l.source === 'cashier' || l.qty !== l.submitted_qty || (l.sold_by === 'weight' && l.actual_grams != null);
  const removed = l.qty === 0;
  return html`<tr class="${removed ? 'removed' : ''} ${l.sold_by === 'weight' && l.actual_grams == null && !removed ? 'needs-weigh' : ''}">
    <td><strong>${l.name_snapshot}</strong>${l.pack_label ? html` <span class="muted">${l.pack_label}</span>` : ''}
      ${l.source === 'cashier' ? html`<span class="badge-s s-added">Added by cashier</span>` : ''}
      ${l.scanned_barcode ? html`<br><small class="muted">scanned ${l.scanned_barcode}</small>` : ''}</td>
    <td>${formatPaise(l.unit_price_paise)}${l.sold_by === 'weight' ? '/kg' : ''}</td>
    <td>${l.sold_by === 'weight'
      ? html`${l.est_grams ? html`<small class="muted">customer est. ${formatGrams(l.est_grams)}</small><br>` : html`<small class="muted">no estimate</small><br>`}
        ${editable && !removed ? html`<form method="post" action="/staff/orders/${o.id}/adjust" class="inline weigh-form">
          <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="type" value="set_weight"><input type="hidden" name="line_id" value="${l.id}">
          <label class="sr-only" for="g${l.id}">Weight in grams for ${l.name_snapshot}</label>
          <input id="g${l.id}" name="grams" type="number" inputmode="numeric" min="1" max="25000" value="${l.actual_grams ?? ''}" placeholder="grams" required> g
          <button class="btn btn-small btn-primary">${l.actual_grams ? 'Update' : 'Set weight'}</button></form>` : l.actual_grams ? html`<strong>${formatGrams(l.actual_grams)}</strong>` : html`<span class="badge-s s-weigh">Not weighed</span>`}`
      : html`${changed && l.source !== 'cashier' ? html`<small class="muted">customer: ${l.submitted_qty}</small><br>` : ''}
        ${editable && !removed ? html`<form method="post" action="/staff/orders/${o.id}/adjust" class="inline">
          <input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="type" value="set_qty"><input type="hidden" name="line_id" value="${l.id}">
          <label class="sr-only" for="q${l.id}">Quantity for ${l.name_snapshot}</label>
          <input id="q${l.id}" name="qty" type="number" inputmode="numeric" min="0" max="999" value="${l.qty}" class="qty-in"> <button class="btn btn-small">Set</button></form>` : html`<strong>${l.qty}</strong>`}`}</td>
    <td class="num">${removed ? html`<span class="muted">removed</span>` : amt.unknown ? '—' : html`${amt.estimated ? '~' : ''}${formatPaise(amt.paise)}`}</td>
    <td>${editable && !removed ? html`<form method="post" action="/staff/orders/${o.id}/adjust" class="inline"><input type="hidden" name="_csrf" value="${csrf}">
      <input type="hidden" name="type" value="remove"><input type="hidden" name="line_id" value="${l.id}"><button class="btn btn-small btn-ghost" aria-label="Remove ${l.name_snapshot}">Remove</button></form>` : ''}</td>
  </tr>`;
}

const EVENT_LABEL: Record<string, string> = {
  submitted: 'Customer submitted basket', pos_delivered: 'Held basket created in POS', claimed: 'Opened by cashier', taken_over: 'Taken over by manager',
  released: 'Released back to queue', transferred: 'Transferred to another cashier', counter_changed: 'Counter changed', line_qty: 'Quantity changed',
  line_weighed: 'Weighed', line_removed: 'Item removed', line_added: 'Item added by cashier', payment_started: 'Payment started',
  payment_uncertain: 'Payment outcome uncertain', payment_failed: 'Payment failed', payment_not_found: 'Payment not found at POS (safe to retry)',
  paid: 'Paid — POS receipt issued', cancelled: 'Cancelled', expired: 'Expired (not paid)', pos_voided: 'Held basket voided in POS',
  reprint_requested: 'Reprint (COPY) requested', print_sent: 'Slip sent to printer', print_printed: 'Slip printed', print_failed: 'Slip failed to print', print_unknown: 'Slip status unknown',
};

export function orderDetailPage(d: { detail: any; staff: StaffUser; counters: Row[]; staffList: Row[]; csrf: string }) {
  const { order: o, lines, events, jobs, counter, claimer, total } = d.detail;
  const mine = o.claimed_by === d.staff.id;
  const open = ['awaiting_payment', 'in_progress'].includes(o.status);
  const editable = open && mine && o.payment_status !== 'pending';
  const unweighed = lines.filter((l: Row) => l.qty > 0 && l.sold_by === 'weight' && l.actual_grams == null);
  const lastSlip = jobs.filter((j: Row) => j.kind !== 'test').at(-1);
  const csrf = d.csrf;
  const hidden = html`<input type="hidden" name="_csrf" value="${csrf}">`;
  return html`
  <p><a href="/staff?branch=${o.branch_id}">← All orders</a></p>
  <div class="order-head">
    <div><p class="muted small">Order</p><h1 class="code-big">${o.code}</h1></div>
    <div>${statusBadge(o.status)} ${printBadge(lastSlip?.status)}
      <p class="muted small">Counter ${counter?.number ?? '—'} · submitted ${storeTime(o.created_at)} (${minutesSince(o.created_at)} min ago)<br>
      POS: ${o.pos_ref ? html`<strong>${o.pos_ref}</strong>` : html`<span class="warn-text">not delivered yet${o.pos_last_error ? ' — ' + o.pos_last_error : ''}</span>`}
      ${o.receipt_no ? html` · Receipt <strong>${o.receipt_no}</strong>` : ''}
      ${claimer ? html`<br>Handled by <strong>${claimer.display_name}</strong>` : ''}</p></div>
  </div>

  ${open && !mine ? html`<div class="notice ${o.claimed_by ? 'warn' : ''}">
    ${o.claimed_by ? html`<strong>${claimer?.display_name}</strong> is handling this order.` : 'Open this order at your counter to check items and take payment.'}
    <form method="post" action="/staff/orders/${o.id}/claim" class="inline">${hidden}
      ${o.claimed_by ? (hasRole(d.staff, 'manager') ? html`<input type="hidden" name="force" value="1"><button class="btn btn-primary">Take over (manager)</button>` : '') : html`<button class="btn btn-primary btn-xl">Open at my counter</button>`}
    </form></div>` : ''}

  ${o.payment_status === 'pending' ? html`<div class="notice warn" role="alert"><strong>Payment outcome not confirmed by POS.</strong> Do not charge again.
    <form method="post" action="/staff/orders/${o.id}/check-payment" class="inline">${hidden}<button class="btn btn-primary">Check payment</button></form></div>` : ''}
  ${o.payment_status === 'failed' && open ? html`<div class="notice warn">The last payment attempt did not complete at the POS. You can try again.</div>` : ''}

  <div class="detail-grid">
    <section class="card">
      <h2>Basket</h2>
      <table class="lines"><thead><tr><th>Item</th><th>Price</th><th>Qty / weight</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>${lines.map((l: Row) => lineRow(o, l, editable, csrf))}</tbody>
        <tfoot><tr><td colspan="3">${o.status === 'paid' ? 'Paid (POS total, incl. rounding)' : total.estimated ? 'Estimated total' : 'Total before POS billing'}</td>
          <td class="num"><strong>${o.status === 'paid' ? formatPaise(o.final_total_paise) : formatPaise(total.paise)}</strong></td><td></td></tr></tfoot>
      </table>
      ${editable ? html`<form method="post" action="/staff/orders/${o.id}/adjust" class="add-item">${hidden}<input type="hidden" name="type" value="add">
        <label for="addbc">Add missed item — scan or type barcode</label>
        <div class="row"><input id="addbc" name="barcode" autocomplete="off" inputmode="numeric" placeholder="Barcode" required>
        <input name="qty" type="number" min="1" max="99" value="1" class="qty-in" aria-label="Quantity">
        <button class="btn">Add</button></div></form>
        <form method="get" action="/staff/item-search" class="add-item"><input type="hidden" name="order" value="${o.id}">
        <label for="adds">…or search by name</label><div class="row"><input id="adds" name="q" placeholder="e.g. coriander"><button class="btn btn-ghost">Search</button></div></form>` : ''}
    </section>

    <aside>
      ${editable ? html`<section class="card pay">
        <h2>Take payment</h2>
        ${unweighed.length ? html`<p class="notice warn">Weigh first: ${unweighed.map((l: Row) => l.name_snapshot).join(', ')}</p>` : ''}
        ${!o.pos_ref ? html`<p class="notice warn">Waiting for the POS to receive this basket.</p>` : ''}
        <form method="post" action="/staff/orders/${o.id}/finalize" class="pay-form">${hidden}
          <fieldset ${unweighed.length || !o.pos_ref ? raw('disabled') : ''}><legend class="sr-only">Payment method</legend>
            <button class="btn btn-primary btn-block" name="method" value="cash">Cash</button>
            <button class="btn btn-primary btn-block" name="method" value="upi">UPI</button>
            <button class="btn btn-primary btn-block" name="method" value="card">Card</button>
            <button class="btn btn-secondary btn-block" name="method" value="other">Other (as per POS)</button>
          </fieldset>
        </form>
        <p class="muted small">The POS calculates the final amount and issues the bill. The order is marked paid only after the POS confirms.</p>
      </section>` : ''}

      ${open ? html`<section class="card">
        <h2>Order actions</h2>
        ${mine ? html`<form method="post" action="/staff/orders/${o.id}/release" class="stack">${hidden}
            <label>Hand over to <select name="to"><option value="">— back to queue —</option>${d.staffList.filter((s) => s.id !== d.staff.id).map((s) => html`<option value="${s.id}">${s.display_name}</option>`)}</select></label>
            <button class="btn btn-small">Transfer / release</button></form>` : ''}
        <form method="post" action="/staff/orders/${o.id}/counter" class="stack">${hidden}
          <label>Move to counter <select name="counter_id">${d.counters.filter((c) => c.active).map((c) => html`<option value="${c.id}" ${c.id === o.counter_id ? raw('selected') : ''}>Counter ${c.number}</option>`)}</select></label>
          <button class="btn btn-small">Move (prints slip there)</button></form>
        <form method="post" action="/staff/orders/${o.id}/cancel" class="stack" data-confirm="Cancel this basket? It will not count as a sale.">${hidden}
          <label>Cancel reason <input name="reason" required placeholder="Customer left / duplicate"></label>
          <button class="btn btn-small btn-danger">Cancel order</button></form>
      </section>` : ''}

      <section class="card">
        <h2>Counter slips</h2>
        <ul class="jobs">${jobs.map((j: Row) => html`<li>${printBadge(j.status)} <strong>${j.kind.toUpperCase()}</strong> · ${storeClock(j.created_at)}${j.created_by_name ? ' · by ' + j.created_by_name : ''}${j.reason ? html` · “${j.reason}”` : ''}
          ${j.error ? html`<br><small class="warn-text">${j.error}</small>` : ''}
          ${j.status === 'failed' ? html`<form method="post" action="/staff/print-jobs/${j.id}/retry" class="inline">${hidden}<button class="btn btn-small">Retry print</button></form>` : ''}
          <details><summary>Preview</summary><pre class="slip">${j.preview}</pre></details></li>`)}</ul>
        <form method="post" action="/staff/orders/${o.id}/reprint" class="stack">${hidden}
          <label>Reprint as COPY — reason <input name="reason" required placeholder="Paper jam / slip lost"></label>
          <button class="btn btn-small">Reprint COPY</button></form>
      </section>

      <section class="card">
        <h2>History</h2>
        <ol class="history">${events.map((e: Row) => {
          const data = JSON.parse(e.data || '{}');
          return html`<li><span class="muted small">${storeClock(e.at)}</span> ${EVENT_LABEL[e.type] ?? e.type}
            ${e.display_name ? html`<small>— ${e.display_name}</small>` : ''}
            ${data.name ? html`<small> · ${data.name}${data.from !== undefined && data.to !== undefined ? ` ${data.from} → ${data.to}` : ''}${data.grams ? ` ${data.grams} g` : ''}</small>` : ''}
            ${data.receipt_no ? html`<small> · ${data.receipt_no} ${formatPaise(data.total_paise)}</small>` : ''}
            ${data.reason ? html`<small> · ${data.reason}</small>` : ''}${data.error ? html`<small class="warn-text"> · ${data.error}</small>` : ''}</li>`;
        })}</ol>
      </section>
    </aside>
  </div>`;
}
