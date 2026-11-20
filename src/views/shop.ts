import { html, raw, type SafeHtml } from '../lib/html.js';
import { t, pickName, type Lang } from '../lib/i18n.js';
import { formatPaise } from '../lib/money.js';
import type { Item } from '../catalogue/service.js';
import { icon } from './layout.js';
import type { Row } from '../db/index.js';

export function itemImage(item: Pick<Item, 'id' | 'image_url' | 'name_en'>, size: 'card' | 'large' = 'card') {
  const src = item.image_url || `/img/item/${item.id}.svg`;
  const dim = size === 'large' ? 480 : 240;
  return html`<img src="${src}" alt="" width="${dim}" height="${dim}" loading="${size === 'large' ? 'eager' : 'lazy'}" decoding="async">`;
}

export function priceLabel(lang: Lang, item: Pick<Item, 'sold_by' | 'price_paise'>) {
  if (item.sold_by === 'weight') return html`${formatPaise(item.price_paise)}<small> / kg</small>`;
  if (item.sold_by === 'piece') return html`${formatPaise(item.price_paise)}<small> ${t(lang, 'each')}</small>`;
  return html`${formatPaise(item.price_paise)}`;
}

/** Item data embedded on cards so the basket works offline without re-fetching. */
export function itemData(item: Item) {
  return JSON.stringify({
    id: item.id, slug: item.slug, name: item.name_en, name_ta: item.name_ta, pack: item.pack_label, sold_by: item.sold_by,
    price: item.price_paise, max: item.max_qty, available: !!item.available,
  });
}

export function productCard(lang: Lang, item: Item) {
  const name = pickName(lang, item.name_en, item.name_ta);
  return html`<article class="card product" data-item="${itemData(item)}">
    <a class="product-link" href="/p/${item.slug}">
      <div class="thumb">${itemImage(item)}</div>
      <h3 class="pname">${name}</h3>
      <p class="pack">${item.brand ? html`<span class="brand-name">${item.brand}</span> · ` : ''}${item.pack_label ?? ''}</p>
    </a>
    <div class="card-foot">
      <p class="price">${priceLabel(lang, item)}${item.mrp_paise && item.mrp_paise > item.price_paise ? html` <s class="mrp">${formatPaise(item.mrp_paise)}</s>` : ''}</p>
      ${item.available
        ? html`<div class="qty-slot" data-qty-slot><button class="btn-add" type="button" data-add aria-label="${t(lang, 'add')} ${name}">${icon('plus')} ${t(lang, 'add')}</button></div>`
        : html`<p class="oos">${t(lang, 'out_of_stock')}</p>`}
    </div>
  </article>`;
}

export function productGrid(lang: Lang, items: Item[]) {
  return html`<div class="grid products">${items.map((i) => productCard(lang, i))}</div>`;
}

export function deptTiles(lang: Lang, depts: Row[], branchSlug?: string) {
  return html`<ul class="dept-tiles">${depts.map(
    (d) => html`<li><a href="${branchSlug ? `/b/${branchSlug}` : ''}/d/${d.slug}" style="--tile:${d.color}">
      <img src="/img/dept/${d.slug}.svg" alt="" width="56" height="56" loading="lazy"><span>${pickName(lang, d.name_en, d.name_ta)}</span></a></li>`,
  )}</ul>`;
}

export function howItWorks(lang: Lang) {
  return html`<section class="how" id="how" aria-labelledby="how-h">
    <h2 id="how-h">${t(lang, 'how_it_works')}</h2>
    <ol class="steps">
      <li><span class="step-n">1</span>${t(lang, 'step1')}</li>
      <li><span class="step-n">2</span>${t(lang, 'step2')}</li>
      <li><span class="step-n">3</span>${t(lang, 'step3')}</li>
      <li><span class="step-n">4</span>${t(lang, 'step4')}</li>
    </ol>
    <p class="muted">${t(lang, 'in_store_only')}</p>
  </section>`;
}

export function storeInfoBlock(lang: Lang, branch: Row) {
  const info = JSON.parse(branch.store_info || '{}');
  if (!info.verified) {
    return html`<div class="card info-card"><h3>${pickName(lang, branch.name_en, branch.name_ta)}</h3>
      <p class="muted">Store address, hours and phone will appear here once confirmed by the owner.</p></div>`;
  }
  return html`<div class="card info-card">
    <h3>${pickName(lang, branch.name_en, branch.name_ta)}</h3>
    ${info.address ? html`<p class="info-row">${icon('pin')}<span>${info.address}</span></p>` : ''}
    ${info.hours?.length ? html`<div class="info-row">${icon('clock')}<ul class="hours">${info.hours.map((h: any) => html`<li><span>${h.days}</span> <span>${h.open} – ${h.close}</span></li>`)}</ul></div>` : ''}
    ${info.phone ? html`<p class="info-row">${icon('phone')}<a href="tel:${info.phone}">${info.phone}</a></p>` : ''}
    ${info.map_url ? html`<p><a class="btn btn-secondary" href="${info.map_url}" rel="noopener" target="_blank">${icon('pin')} ${t(lang, 'get_directions')}</a></p>` : ''}
  </div>`;
}

// ---------------- pages ----------------

export function homePage(lang: Lang, d: { branches: Row[]; departments: Row[]; featured: Item[] }) {
  const primary = d.branches[0];
  const info = primary ? JSON.parse(primary.store_info || '{}') : {};
  return html`
  <section class="hero">
    <div class="hero-copy">
      <p class="eyebrow">Madhuram Pazhamudhir Cholai</p>
      <h1>${lang === 'ta' ? 'புதிய பழங்கள், காய்கறிகள் & தினசரி மளிகை' : 'Fresh fruits, vegetables & daily groceries'}</h1>
      <p class="lead">${lang === 'ta' ? 'உங்கள் போனிலேயே பொருட்களைத் தேடி, ஸ்கேன் செய்து, கவுண்டரில் வேகமாகப் பணம் செலுத்துங்கள்.' : 'Find what you need, scan as you shop, and pay quickly at the counter.'}</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="${primary ? `/b/${primary.slug}` : '#departments'}">${t(lang, 'explore_products')} ${icon('arrow')}</a>
        ${info.verified && info.map_url ? html`<a class="btn btn-secondary" href="${info.map_url}" rel="noopener" target="_blank">${icon('pin')} ${t(lang, 'get_directions')}</a>` : html`<a class="btn btn-secondary" href="/visit">${icon('pin')} ${t(lang, 'visit_store')}</a>`}
      </div>
    </div>
    <div class="hero-art" aria-hidden="true">${raw(heroArt())}</div>
  </section>
  <section id="departments" aria-labelledby="dep-h">
    <div class="section-head"><h2 id="dep-h">${t(lang, 'departments')}</h2></div>
    ${deptTiles(lang, d.departments, primary?.slug)}
  </section>
  ${d.featured.length ? html`<section aria-labelledby="fresh-h">
    <div class="section-head"><h2 id="fresh-h">${lang === 'ta' ? 'இன்று புதியவை' : 'Fresh picks'}</h2>${primary ? html`<a href="/b/${primary.slug}/d/vegetables">${t(lang, 'see_all')}</a>` : ''}</div>
    ${productGrid(lang, d.featured)}
  </section>` : ''}
  ${howItWorks(lang)}
  <section aria-labelledby="visit-h"><h2 id="visit-h">${t(lang, 'visit_store')}</h2>
    <div class="grid two">${d.branches.map((b) => storeInfoBlock(lang, b))}</div>
  </section>`;
}

export function branchPage(lang: Lang, d: { branch: Row; departments: Row[]; featured: Item[]; inStore: boolean }) {
  const paused = !d.branch.accepting_orders;
  return html`
  ${paused ? html`<div class="notice warn" role="alert">${(lang === 'ta' ? d.branch.pause_message_ta : d.branch.pause_message_en) || t(lang, 'accepting_paused')}</div>` : ''}
  <section class="shop-start">
    <h1 class="sr-only">${pickName(lang, d.branch.name_en, d.branch.name_ta)} — Scan & Shop</h1>
    <p class="hello">${d.inStore ? (lang === 'ta' ? 'வணக்கம்! நீங்கள் கடையில் இருக்கிறீர்கள்.' : 'Welcome! You are shopping in') : (lang === 'ta' ? 'கிளை' : 'Shopping at')} <strong>${pickName(lang, d.branch.name_en, d.branch.name_ta)}</strong></p>
    <div class="start-actions">
      <button type="button" class="btn btn-primary btn-xl" data-open-scanner>${icon('scan')} ${t(lang, 'scan_product')}</button>
      <a class="btn btn-secondary btn-xl" href="/b/${d.branch.slug}/search" data-focus-search>${icon('search')} ${t(lang, 'search_products')}</a>
    </div>
  </section>
  <section aria-labelledby="dep-h">
    <div class="section-head"><h2 id="dep-h">${t(lang, 'departments')}</h2></div>
    ${deptTiles(lang, d.departments, d.branch.slug)}
  </section>
  <section aria-labelledby="pop-h">
    <div class="section-head"><h2 id="pop-h">${lang === 'ta' ? 'அதிகம் வாங்கப்படுபவை' : 'Popular today'}</h2></div>
    ${productGrid(lang, d.featured)}
  </section>
  ${d.inStore ? '' : howItWorks(lang)}`;
}

export function departmentPage(lang: Lang, d: { dept: Row; items: Item[]; total: number; page: number; perPage: number; base: string }) {
  const pages = Math.ceil(d.total / d.perPage);
  return html`
  <nav class="crumbs" aria-label="Breadcrumb"><a href="${d.base || '/'}">${t(lang, 'home')}</a> / <span>${pickName(lang, d.dept.name_en, d.dept.name_ta)}</span></nav>
  <h1>${pickName(lang, d.dept.name_en, d.dept.name_ta)} <span class="count">${d.total}</span></h1>
  ${productGrid(lang, d.items)}
  ${pages > 1 ? html`<nav class="pager" aria-label="Pages">${Array.from({ length: pages }, (_, i) => i + 1).map((p) =>
    p === d.page ? html`<span aria-current="page">${p}</span>` : html`<a href="?page=${p}">${p}</a>`)}</nav>` : ''}`;
}

export function searchPage(lang: Lang, d: { q: string; items: Item[]; total: number; page: number; perPage: number }) {
  const more = d.page * d.perPage < d.total;
  return html`
  <h1 class="h-sm">${d.q ? html`${t(lang, 'results_for')} “${d.q}” <span class="count">${d.total}</span>` : t(lang, 'search_products')}</h1>
  ${d.q && !d.items.length ? html`<div class="empty"><p>${t(lang, 'no_results')}</p><button class="btn btn-secondary" data-open-scanner>${icon('scan')} ${t(lang, 'scan_product')}</button></div>` : ''}
  ${productGrid(lang, d.items)}
  ${more ? html`<p class="center"><a class="btn btn-secondary" href="?q=${encodeURIComponent(d.q)}&page=${d.page + 1}">${t(lang, 'load_more')}</a></p>` : ''}`;
}

export function productPage(lang: Lang, d: { item: Item; related: Item[]; dept?: Row; branchSlug?: string }) {
  const it = d.item;
  const name = pickName(lang, it.name_en, it.name_ta);
  const save = it.mrp_paise && it.mrp_paise > it.price_paise ? it.mrp_paise - it.price_paise : 0;
  return html`
  <nav class="crumbs" aria-label="Breadcrumb"><a href="${d.branchSlug ? `/b/${d.branchSlug}` : '/'}">${t(lang, 'home')}</a>
    ${d.dept ? html` / <a href="${d.branchSlug ? `/b/${d.branchSlug}` : ''}/d/${d.dept.slug}">${pickName(lang, d.dept.name_en, d.dept.name_ta)}</a>` : ''} / <span>${name}</span></nav>
  <article class="pdp" data-item="${itemData(it)}">
    <div class="pdp-img">${itemImage(it, 'large')}</div>
    <div class="pdp-info">
      ${d.dept ? html`<p class="eyebrow">${pickName(lang, d.dept.name_en, d.dept.name_ta)}</p>` : ''}
      <h1>${name}</h1>
      ${lang === 'ta' && it.name_ta ? html`<p class="muted">${it.name_en}</p>` : it.name_ta ? html`<p class="muted" lang="ta">${it.name_ta}</p>` : ''}
      <p class="pack">${it.brand ? html`<span class="brand-name">${it.brand}</span> · ` : ''}${it.pack_label ?? ''}</p>
      <p class="price big">${priceLabel(lang, it)}</p>
      ${save ? html`<p class="save">${t(lang, 'mrp')} <s>${formatPaise(it.mrp_paise!)}</s> · ${t(lang, 'you_save')} ${formatPaise(save)}</p>` : ''}
      <p class="stock ${it.available ? 'ok' : 'no'}">${it.available ? html`${icon('check')} ${t(lang, 'in_stock')}` : t(lang, 'out_of_stock')}</p>
      ${it.sold_by === 'weight' ? html`<p class="muted">${t(lang, 'counter_will_weigh')}</p>` : ''}
      ${it.available ? html`<div class="qty-slot pdp-qty" data-qty-slot><button class="btn btn-primary btn-xl" type="button" data-add>${icon('plus')} ${t(lang, 'add')}</button></div>` : ''}
      <p class="muted small">${t(lang, 'in_store_only')}</p>
    </div>
  </article>
  ${d.related.length ? html`<section aria-labelledby="rel-h"><h2 id="rel-h">${t(lang, 'related_sizes')}</h2>${productGrid(lang, d.related)}</section>` : ''}`;
}

export function basketPage(lang: Lang, d: { inStore: boolean; branch?: Row | null; branches: Row[] }) {
  return html`
  <h1>${t(lang, 'basket')}</h1>
  <div data-basket-root data-in-store="${d.inStore ? '1' : '0'}">
    <noscript><p>Please enable JavaScript to use the basket.</p></noscript>
    <div class="empty" data-basket-empty hidden><p>${t(lang, 'empty_basket')}</p>
      <a class="btn btn-primary" href="${d.branch ? `/b/${d.branch.slug}` : '/'}">${t(lang, 'start_shopping')}</a></div>
    <div class="notice warn" data-changes hidden role="alert"></div>
    <ul class="basket-lines" data-lines></ul>
    <div class="basket-summary card" data-summary hidden>
      <div class="sum-row"><span data-total-label>${t(lang, 'total')}</span><strong data-total></strong></div>
      <p class="muted small" data-est-note hidden>${t(lang, 'counter_will_weigh')}</p>
      <div class="notice" data-not-in-store hidden>
        <p>${t(lang, 'in_store_only')}</p>
        <label class="check"><input type="checkbox" data-confirm-in-store> ${lang === 'ta' ? 'நான் இப்போது கடையில் இருக்கிறேன்' : 'I am in the store now and will pay at the counter'}</label>
      </div>
      <div class="notice warn" data-paused hidden role="alert"></div>
      <button class="btn btn-primary btn-xl btn-block" type="button" data-submit>${t(lang, 'pay_at_counter')}</button>
      <p class="muted small center" data-offline-note hidden>${t(lang, 'reconnect_to_send')}</p>
    </div>
  </div>`;
}

export function ticketPage(lang: Lang, d: { token: string; view: any; branch: Row }) {
  return html`
  <section class="ticket" data-ticket="${d.token}" aria-live="polite">
    <div class="ticket-card" data-ticket-card>
      ${raw(ticketInner(lang, d.view))}
    </div>
    <p class="muted small center">${t(lang, 'keep_this_open')}</p>
    <div class="center"><button type="button" class="btn btn-ghost" data-new-basket>${t(lang, 'new_basket')}</button></div>
  </section>`;
}

/** Shared with the polling endpoint so the ticket updates without reload. */
export function ticketInner(lang: Lang, v: any): string {
  const status = v.status as string;
  const statusText = t(lang, `ticket_status_${status}` as any);
  const done = ['paid', 'cancelled', 'expired'].includes(status);
  const body: SafeHtml = html`
    <p class="ticket-label">${t(lang, 'order')}</p>
    <p class="ticket-code">${v.code}</p>
    ${!done ? html`<p class="ticket-counter">${v.counter ? html`${t(lang, 'go_to_counter')} <strong>${v.counter.number}</strong>` : t(lang, 'go_to_counter')}</p>
      <p class="ticket-instr">${t(lang, 'bring_basket')}</p>` : ''}
    <p class="ticket-status status-${status}"><span class="dot" aria-hidden="true"></span>${statusText}</p>
    ${!done && v.pos_pending ? html`<p class="muted small">${t(lang, 'pos_pending')}</p>` : ''}
    ${status === 'paid' ? html`<p class="paid-total">${formatPaise(v.final_total_paise)}</p><p class="muted small">Bill no. ${v.receipt_no}</p>` : ''}
    <details class="ticket-items"><summary>${v.lines.length} ${v.lines.length === 1 ? t(lang, 'item') : t(lang, 'items')} · ${v.estimated ? t(lang, 'estimated_total') : t(lang, 'total')} ${formatPaise(v.est_total_paise)}</summary>
      <ul>${v.lines.map((l: any) => html`<li><span>${pickName(lang, l.name, l.name_ta)} ${l.pack_label ? html`<small>${l.pack_label}</small>` : ''}</span>
        <span>${l.sold_by === 'weight' ? (l.actual_grams ? `${l.actual_grams} g` : l.est_grams ? `~${l.est_grams} g` : t(lang, 'weigh_at_counter')) : `× ${l.qty}`}</span></li>`)}</ul>
    </details>
    ${!done ? html`<p class="muted small">${t(lang, 'add_more_note')}</p>` : ''}`;
  return body.value;
}

export function visitPage(lang: Lang, branches: Row[]) {
  return html`<h1>${t(lang, 'visit_store')}</h1>
    <div class="grid two">${branches.map((b) => storeInfoBlock(lang, b))}</div>
    ${howItWorks(lang)}`;
}

export function errorPage(lang: Lang, status: number, message: string) {
  return html`<div class="empty"><h1>${status === 404 ? t(lang, 'not_found') : 'Something went wrong'}</h1><p>${message}</p><p><a class="btn btn-primary" href="/">${t(lang, 'home')}</a></p></div>`;
}

function heroArt() {
  // Original illustration: market basket with produce (simple geometric shapes).
  return `<svg viewBox="0 0 360 300" role="img" aria-label="">
  <ellipse cx="180" cy="270" rx="150" ry="16" fill="#0B5A2A" opacity=".08"/>
  <circle cx="120" cy="120" r="46" fill="#F2B632"/><path d="M120 74c10-18 30-24 44-22-6 14-22 24-44 22Z" fill="#6FA83A"/>
  <circle cx="205" cy="105" r="40" fill="#D94A2B"/><path d="M200 66c4-6 12-8 18-6-4 6-10 8-18 6Z" fill="#3E7D2B"/>
  <ellipse cx="262" cy="140" rx="34" ry="44" fill="#7CB342"/><path d="M262 96v88" stroke="#5B8F2E" stroke-width="4"/>
  <path d="M60 150h240l-26 110a12 12 0 0 1-12 9H98a12 12 0 0 1-12-9L60 150Z" fill="#0B5A2A"/>
  <path d="M84 176h192M92 206h176M100 236h160" stroke="#FDF9E6" stroke-opacity=".25" stroke-width="6" stroke-linecap="round"/>
  <path d="M110 150c0-50 30-76 70-76s70 26 70 76" fill="none" stroke="#0B5A2A" stroke-width="10" stroke-linecap="round"/>
</svg>`;
}
