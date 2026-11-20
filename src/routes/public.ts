import { Router } from 'express';
import type { AppContext } from '../context.js';
import { layout } from '../views/layout.js';
import * as V from '../views/shop.js';
import { deptSvg, itemSvg } from '../views/svg.js';
import { HttpError } from '../lib/util.js';
import { pickName } from '../lib/i18n.js';
import { IN_STORE_COOKIE, asyncH, inStoreBranch, langOf, noStore } from './helpers.js';
import { config } from '../config.js';
import type { Row } from '../db/index.js';
import type { Item } from '../catalogue/service.js';

const PER_PAGE = 24;

export function publicRoutes(ctx: AppContext) {
  const r = Router();
  const { catalogue, orders } = ctx;
  const base = config.publicBaseUrl;
  const defaultBranch = () => orders.branches()[0];

  function storeJsonLd(b: Row) {
    const info = JSON.parse(b.store_info || '{}');
    if (!info.verified) return null;
    return {
      '@context': 'https://schema.org',
      '@type': 'GroceryStore',
      name: `Madhuram Pazhamudhir Cholai (MPC) — ${b.name_en}`,
      url: `${base}/b/${b.slug}`,
      image: `${base}/brand/og-image.png`,
      logo: `${base}/brand/icon-512.png`,
      ...(info.phone ? { telephone: info.phone } : {}),
      ...(info.address ? { address: { '@type': 'PostalAddress', streetAddress: info.address, addressLocality: info.locality, postalCode: info.postal_code, addressCountry: 'IN' } } : {}),
      ...(info.geo?.lat ? { geo: { '@type': 'GeoCoordinates', latitude: info.geo.lat, longitude: info.geo.lng } } : {}),
      ...(info.map_url ? { hasMap: info.map_url } : {}),
      ...(info.hours_spec?.length ? { openingHoursSpecification: info.hours_spec } : {}),
    };
  }

  const page = (req: any, o: Omit<Parameters<typeof layout>[0], 'lang' | 'departments'> & { departments?: Row[] }) =>
    layout({ lang: langOf(req), departments: catalogue.activeDepartments(), defaultBranch: defaultBranch()?.slug ?? null, ...o }).value;

  r.get('/', (req, res) => {
    const lang = langOf(req);
    const branches = orders.branches();
    const ld = [
      { '@context': 'https://schema.org', '@type': 'Organization', name: 'Madhuram Pazhamudhir Cholai', alternateName: 'MPC', url: base, logo: `${base}/brand/icon-512.png` },
      ...branches.map(storeJsonLd).filter(Boolean),
    ];
    res.send(page(req, {
      title: 'MPC — Madhuram Pazhamudhir Cholai | Fresh fruits, vegetables & groceries',
      description: 'Fresh fruits, vegetables, rice, dals, dairy and daily essentials at Madhuram Pazhamudhir Cholai. Browse products and shop faster in store with Scan & Shop.',
      canonical: '/', jsonLd: ld,
      body: V.homePage(lang, { branches, departments: catalogue.activeDepartments(), featured: catalogue.featured(8) }),
    }));
  });

  // Entrance QR target: stable per-branch URL.
  r.get('/s/:slug', (req, res) => {
    const b = orders.branchBySlug(req.params.slug);
    if (!b) throw new HttpError(404, 'NOT_FOUND', 'Unknown store');
    res.cookie(IN_STORE_COOKIE, b.slug, { maxAge: 4 * 3600 * 1000, sameSite: 'lax', httpOnly: false, path: '/' });
    res.redirect(302, `/b/${b.slug}?instore=1`);
  });

  const branchOr404 = (slug: string) => {
    const b = orders.branchBySlug(slug);
    if (!b) throw new HttpError(404, 'NOT_FOUND', 'Unknown store');
    return b;
  };

  r.get('/b/:slug', (req, res) => {
    const lang = langOf(req);
    const branch = branchOr404(req.params.slug);
    const inStore = inStoreBranch(req) === branch.slug || req.query.instore === '1';
    const ld = storeJsonLd(branch);
    res.send(page(req, {
      title: `${pickName(lang, branch.name_en, branch.name_ta)} — MPC Scan & Shop`,
      description: `Shop at Madhuram Pazhamudhir Cholai, ${branch.name_en}. Scan products as you shop and pay at the counter.`,
      canonical: `/b/${branch.slug}`, jsonLd: ld ? [ld] : [], branch, inStore,
      body: V.branchPage(lang, { branch, departments: catalogue.activeDepartments(), featured: catalogue.featured(12), inStore }),
    }));
  });

  function deptHandler(req: any, res: any, branch?: Row) {
    const lang = langOf(req);
    const dept = catalogue.department(req.params.dept);
    if (!dept) throw new HttpError(404, 'NOT_FOUND', 'Department not found');
    const total = catalogue.countInDepartment(dept.slug);
    if (!total) throw new HttpError(404, 'NOT_FOUND', 'Department not found');
    const pageNo = Math.max(1, Number(req.query.page) || 1);
    const items = catalogue.inDepartment(dept.slug, PER_PAGE, (pageNo - 1) * PER_PAGE);
    const name = pickName(lang, dept.name_en, dept.name_ta);
    res.send(page(req, {
      title: `${name} — MPC Madhuram Pazhamudhir Cholai`,
      description: `${dept.name_en} at Madhuram Pazhamudhir Cholai: ${items.slice(0, 6).map((i) => i.name_en).join(', ')} and more.`,
      canonical: `/d/${dept.slug}${pageNo > 1 ? `?page=${pageNo}` : ''}`,
      branch, inStore: branch ? inStoreBranch(req) === branch.slug : false,
      jsonLd: [{ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: base + '/' }, { '@type': 'ListItem', position: 2, name: dept.name_en, item: `${base}/d/${dept.slug}` }] }],
      body: V.departmentPage(lang, { dept, items, total, page: pageNo, perPage: PER_PAGE, base: branch ? `/b/${branch.slug}` : '' }),
    }));
  }
  r.get('/d/:dept', (req, res) => deptHandler(req, res));
  r.get('/b/:slug/d/:dept', (req, res) => deptHandler(req, res, branchOr404(req.params.slug)));

  function searchHandler(req: any, res: any, branch?: Row) {
    const lang = langOf(req);
    const q = String(req.query.q ?? '').slice(0, 80);
    const pageNo = Math.max(1, Number(req.query.page) || 1);
    const { items, total } = catalogue.search(q, PER_PAGE * pageNo, 0);
    res.send(page(req, {
      title: q ? `“${q}” — MPC search` : 'Search — MPC', noindex: true, branch, inStore: branch ? inStoreBranch(req) === branch.slug : false, searchQuery: q,
      body: V.searchPage(lang, { q, items, total, page: pageNo, perPage: PER_PAGE }),
    }));
  }
  r.get('/search', (req, res) => searchHandler(req, res));
  r.get('/b/:slug/search', (req, res) => searchHandler(req, res, branchOr404(req.params.slug)));

  r.get('/p/:slug', (req, res) => {
    const lang = langOf(req);
    const item = catalogue.bySlug(req.params.slug);
    if (!item) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
    const dept = item.department ? catalogue.department(item.department) : undefined;
    const ib = inStoreBranch(req);
    const branch = ib ? orders.branchBySlug(ib) : undefined;
    const productLd: Record<string, unknown> = {
      '@context': 'https://schema.org', '@type': 'Product', name: `${item.name_en}${item.pack_label ? ' ' + item.pack_label : ''}`,
      image: base + (item.image_url ?? `/img/item/${item.id}.svg`), ...(item.brand ? { brand: { '@type': 'Brand', name: item.brand } } : {}),
      offers: { '@type': 'Offer', priceCurrency: 'INR', price: (item.price_paise / 100).toFixed(2), availability: item.available ? 'https://schema.org/InStoreOnly' : 'https://schema.org/OutOfStock',
        ...(item.sold_by === 'weight' ? { priceSpecification: { '@type': 'UnitPriceSpecification', price: (item.price_paise / 100).toFixed(2), priceCurrency: 'INR', unitCode: 'KGM' } } : {}) },
    };
    res.send(page(req, {
      title: `${item.name_en}${item.pack_label ? ' ' + item.pack_label : ''} — MPC`,
      description: `${item.name_en}${item.pack_label ? ' (' + item.pack_label + ')' : ''} at Madhuram Pazhamudhir Cholai. Available in store — scan, shop and pay at the counter.`,
      canonical: `/p/${item.slug}`, jsonLd: [productLd], branch, inStore: !!branch,
      body: V.productPage(lang, { item, related: catalogue.related(item), dept, branchSlug: branch?.slug }),
    }));
  });

  r.get('/basket', (req, res) => {
    noStore(res);
    const lang = langOf(req);
    const ib = inStoreBranch(req);
    const branch = ib ? orders.branchBySlug(ib) : undefined;
    res.send(page(req, { title: 'Basket — MPC', noindex: true, branch, inStore: !!branch, hideBasketBar: true, body: V.basketPage(lang, { inStore: !!branch, branch, branches: orders.branches() }) }));
  });

  r.get('/t/:token', (req, res) => {
    noStore(res);
    res.setHeader('Referrer-Policy', 'no-referrer');
    const lang = langOf(req);
    const order = orders.byTicket(req.params.token);
    if (!order) throw new HttpError(404, 'NOT_FOUND', 'Ticket not found');
    const branch = orders.branch(order.branch_id)!;
    res.send(page(req, { title: `Order ${order.code} — MPC`, noindex: true, branch, inStore: true, hideBasketBar: true, departments: [],
      body: V.ticketPage(lang, { token: req.params.token, view: orders.ticketView(order), branch }) }));
  });

  r.get('/visit', (req, res) => {
    const lang = langOf(req);
    const branches = orders.branches();
    res.send(page(req, { title: 'Visit the store — MPC Madhuram Pazhamudhir Cholai', description: 'Address, opening hours and directions for Madhuram Pazhamudhir Cholai.', canonical: '/visit',
      jsonLd: branches.map(storeJsonLd).filter(Boolean), body: V.visitPage(lang, branches) }));
  });

  r.post('/lang', (req, res) => {
    const lang = req.body?.lang === 'ta' ? 'ta' : 'en';
    res.cookie('lang', lang, { maxAge: 365 * 86400 * 1000, sameSite: 'lax', path: '/' });
    let back = '/';
    try {
      // only ever redirect to a path on this site
      if (req.headers.referer) { const u = new URL(req.headers.referer, base); back = u.pathname + u.search; }
    } catch { /* ignore */ }
    res.redirect(303, back.startsWith('/') && !back.startsWith('//') ? back : '/');
  });

  // ---- generated images ----
  r.get('/img/item/:id.svg', (req, res) => {
    const item = catalogue.byId(Number(req.params.id)) as Item | undefined;
    if (!item) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const dept = item.department ? catalogue.department(item.department) : undefined;
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(itemSvg(item, dept?.color ? dept.color : undefined));
  });
  r.get('/img/dept/:slug.svg', (req, res) => {
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(deptSvg(req.params.slug, '#ffffff'));
  });

  // ---- SEO plumbing ----
  r.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send(
      config.allowIndexing
        ? `User-agent: *\nDisallow: /basket\nDisallow: /t/\nDisallow: /staff\nDisallow: /admin\nDisallow: /api/\nDisallow: /search\nDisallow: /b/*/search\nAllow: /\nSitemap: ${base}/sitemap.xml\n`
        : `User-agent: *\nDisallow: /\n`,
    );
  });
  r.get('/sitemap.xml', (_req, res) => {
    const urls = ['/', '/visit', ...orders.branches().map((b) => `/b/${b.slug}`), ...catalogue.activeDepartments().map((d) => `/d/${d.slug}`),
      ...ctx.db.all<{ slug: string }>('SELECT slug FROM items WHERE active = 1 ORDER BY id LIMIT 45000').map((i) => `/p/${i.slug}`)];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `<url><loc>${base}${u}</loc></url>`).join('\n')}\n</urlset>`);
  });
  r.get('/manifest.webmanifest', (_req, res) => {
    res.type('application/manifest+json').send(JSON.stringify({
      name: 'MPC Scan & Shop', short_name: 'MPC', start_url: '/', display: 'standalone', background_color: '#FDF9E6', theme_color: '#0B5A2A',
      icons: [{ src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' }],
    }));
  });
  r.get('/healthz', asyncH(async (_req, res) => {
    res.json({ ok: true, pos: await ctx.pos.health(), demo: config.demoMode });
  }));
  return r;
}
