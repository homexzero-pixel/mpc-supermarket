import { html, raw, jsonScript, type SafeHtml } from '../lib/html.js';
import { t, clientStrings, type Lang } from '../lib/i18n.js';
import { config } from '../config.js';

export interface PageOpts {
  lang: Lang;
  title: string;
  description?: string;
  canonical?: string;           // path, e.g. /p/tomato
  noindex?: boolean;
  jsonLd?: unknown[];
  body: SafeHtml;
  branch?: Record<string, any> | null;
  inStore?: boolean;
  departments?: Record<string, any>[];
  scripts?: string[];
  bodyClass?: string;
  hideBasketBar?: boolean;
  ogImage?: string;
  searchQuery?: string;
  defaultBranch?: string | null;
  currentPath?: string;
}

export const ASSET_VERSION = '1';
const asset = (p: string) => `${p}?v=${ASSET_VERSION}`;

function langToggle(lang: Lang, currentPath = '/') {
  return html`<form method="post" action="/lang" class="lang-form">
    <input type="hidden" name="lang" value="${lang === 'en' ? 'ta' : 'en'}"><input type="hidden" name="next" value="${currentPath}">
    <button class="chip lang-btn" type="submit" lang="${lang === 'en' ? 'ta' : 'en'}" aria-label="${lang === 'en' ? 'Switch to Tamil' : 'Switch to English'}">${t(lang, 'language')}</button>
  </form>`;
}

export function icon(name: 'search' | 'scan' | 'basket' | 'home' | 'pin' | 'clock' | 'phone' | 'back' | 'plus' | 'minus' | 'x' | 'check' | 'arrow') {
  const p: Record<string, string> = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    scan: '<path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M7 9v6M10 9v6M13 9v6M16 9v6"/>',
    basket: '<path d="M5 9h14l-1.4 9.1a2 2 0 0 1-2 1.7H8.4a2 2 0 0 1-2-1.7L5 9Z"/><path d="M9 9 12 4l3 5"/>',
    home: '<path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z"/>',
    pin: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    phone: '<path d="M6.6 4h2.6l1.3 4-2 1.3a11 11 0 0 0 6.2 6.2l1.3-2 4 1.3v2.6A1.6 1.6 0 0 1 18.4 19 15 15 0 0 1 5 5.6 1.6 1.6 0 0 1 6.6 4Z"/>',
    back: '<path d="M15 5 8 12l7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12 4.5 4.5L19 7"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  };
  return raw(`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p[name]}</svg>`);
}

export function layout(o: PageOpts) {
  const base = config.publicBaseUrl;
  const canonical = o.canonical ? base + o.canonical : undefined;
  const branchPath = o.branch ? `/b/${o.branch.slug}` : '/';
  const searchAction = o.branch ? `/b/${o.branch.slug}/search` : '/search';
  const robots = o.noindex || !config.allowIndexing ? 'noindex, nofollow' : 'index, follow';
  return html`<!doctype html>
<html lang="${o.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${o.title}</title>
${o.description ? html`<meta name="description" content="${o.description}">` : ''}
<meta name="robots" content="${robots}">
${canonical ? html`<link rel="canonical" href="${canonical}">` : ''}
<meta name="theme-color" content="#0B5A2A">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Madhuram Pazhamudhir Cholai">
<meta property="og:title" content="${o.title}">
${o.description ? html`<meta property="og:description" content="${o.description}">` : ''}
${canonical ? html`<meta property="og:url" content="${canonical}">` : ''}
<meta property="og:image" content="${o.ogImage ?? base + '/brand/og-image.png'}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="/brand/icon-192.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="preload" href="/fonts/poppins-latin-600-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${asset('/css/app.css')}">
${(o.jsonLd ?? []).map((j) => html`<script type="application/ld+json">${jsonScript(j)}</script>`)}
</head>
<body class="${o.bodyClass ?? ''} ${o.inStore ? 'in-store' : ''}">
<a class="skip" href="#main">Skip to content</a>
${config.demoMode ? html`<div class="demo-banner" role="note">${t(o.lang, 'demo_banner')}</div>` : ''}
<header class="site-header">
  <div class="wrap header-row">
    <a class="brand" href="${branchPath}" aria-label="MPC home">
      <img src="/brand/mpc-logo-480.webp" alt="MPC — Madhuram Pazhamudhir Cholai" width="120" height="44">
      ${o.branch ? html`<span class="branch-tag">${o.lang === 'ta' && o.branch.name_ta ? o.branch.name_ta : o.branch.name_en}</span>` : ''}
    </a>
    <form class="search-form desktop-only" role="search" action="${searchAction}" method="get">
      <label class="sr-only" for="q-desk">${t(o.lang, 'search_products')}</label>
      ${icon('search')}<input id="q-desk" name="q" type="search" value="${o.searchQuery ?? ''}" placeholder="${t(o.lang, 'search_placeholder')}" autocomplete="off" enterkeyhint="search">
    </form>
    <div class="header-actions">
      ${langToggle(o.lang, o.currentPath)}
      <a class="icon-btn basket-link" href="/basket" aria-label="${t(o.lang, 'basket')}">${icon('basket')}<span class="badge" data-basket-count hidden>0</span></a>
    </div>
  </div>
  <div class="wrap mobile-only mobile-search">
    <form class="search-form" role="search" action="${searchAction}" method="get">
      <label class="sr-only" for="q-mob">${t(o.lang, 'search_products')}</label>
      ${icon('search')}<input id="q-mob" name="q" type="search" value="${o.searchQuery ?? ''}" placeholder="${t(o.lang, 'search_placeholder')}" autocomplete="off" enterkeyhint="search">
      <button type="button" class="scan-inline" data-open-scanner aria-label="${t(o.lang, 'scan_product')}">${icon('scan')}</button>
    </form>
  </div>
  ${o.departments?.length ? html`<nav class="dept-nav desktop-only" aria-label="${t(o.lang, 'departments')}"><div class="wrap">
    ${o.departments.map((d) => html`<a href="${o.branch ? `/b/${o.branch.slug}` : ''}/d/${d.slug}">${o.lang === 'ta' && d.name_ta ? d.name_ta : d.name_en}</a>`)}
    <a href="/visit">${t(o.lang, 'visit_store')}</a>
  </div></nav>` : ''}
</header>
<div class="offline-bar" data-offline hidden role="status">${t(o.lang, 'you_are_offline')}</div>
<main id="main" class="wrap">
${o.body}
</main>
<footer class="site-footer">
  <div class="wrap">
    <img src="/brand/mpc-logo-480.webp" alt="" width="96" height="35" loading="lazy">
    <p>Madhuram Pazhamudhir Cholai · <a href="/visit">${t(o.lang, 'visit_store')}</a> · <a href="/#how">${t(o.lang, 'how_it_works')}</a></p>
    <p class="muted small"><a href="/staff">Staff sign-in</a></p>
  </div>
</footer>
${o.hideBasketBar ? '' : html`<div class="bottom-dock" data-dock>
  <a class="basket-bar" href="/basket" data-basket-bar hidden>
    <span data-basket-summary></span><span class="bar-cta">${t(o.lang, 'view_basket')} ${icon('arrow')}</span>
  </a>
  <nav class="bottom-nav mobile-only" aria-label="Shopping">
    <a href="${branchPath}">${icon('home')}<span>${t(o.lang, 'home')}</span></a>
    <button type="button" class="scan-fab" data-open-scanner>${icon('scan')}<span>${t(o.lang, 'scan')}</span></button>
    <a href="/basket">${icon('basket')}<span>${t(o.lang, 'basket')}</span></a>
  </nav>
</div>`}
<div class="toast" role="status" aria-live="polite" data-toast hidden></div>
<script type="application/json" id="mpc-data">${jsonScript({ lang: o.lang, strings: clientStrings(o.lang), branch: o.branch ? { slug: o.branch.slug, name: o.branch.name_en, name_ta: o.branch.name_ta } : null, defaultBranch: o.defaultBranch ?? null, inStore: !!o.inStore })}</script>
<script src="${asset('/js/shop.js')}" defer></script>
${(o.scripts ?? []).map((s) => html`<script src="${asset(s)}" defer></script>`)}
</body>
</html>`;
}
