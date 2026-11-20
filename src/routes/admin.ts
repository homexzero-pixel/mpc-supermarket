import { Router, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import type { AppContext } from '../context.js';
import { HttpError, addSeconds, businessDate, newId, nowIso, randomToken, sha256 } from '../lib/util.js';
import { assertBranch, canAccessBranch, hashPassword, requireRole, type StaffUser } from '../lib/auth.js';
import { validateScaleRules } from '../lib/barcode.js';
import { parseRupeesToPaise } from '../lib/money.js';
import { csvRowsToItems, parseCsv } from '../catalogue/service.js';
import * as SV from '../views/staff.js';
import * as AV from '../views/admin.js';
import { asyncH, done, flash, noStore, wantsJson } from './helpers.js';
import { config } from '../config.js';
import type { Row } from '../db/index.js';
import type { Worker } from '../worker.js';

export function adminRoutes(ctx: AppContext, worker?: Worker) {
  const r = Router();
  const { db, orders, print, catalogue } = ctx;
  r.use('/admin', (_req, res, next) => {
    noStore(res);
    next();
  });

  const staffOf = (req: Request) => req.staff as StaffUser;
  function branchFor(req: Request) {
    const s = staffOf(req);
    const wanted = String(req.query.branch ?? '');
    const all = orders.branches().filter((b) => canAccessBranch(s, b.id));
    if (!all.length) throw new HttpError(403, 'BRANCH', 'No branch assigned');
    return { branch: all.find((b) => b.id === wanted) ?? all[0], branches: all };
  }
  function branchParam(req: Request) {
    const b = orders.branch(String(req.params.id));
    if (!b) throw new HttpError(404, 'NOT_FOUND', 'Branch not found');
    assertBranch(staffOf(req), b.id);
    return b;
  }
  const audit = (req: Request, action: string, target: string, data: unknown = {}) =>
    db.run('INSERT INTO audit_log (at, staff_id, action, target, data) VALUES (?,?,?,?,?)', nowIso(), staffOf(req).id, action, target, JSON.stringify(data));
  const action = (fn: (req: Request, res: Response) => unknown) =>
    asyncH(async (req, res) => {
      try {
        await fn(req, res);
      } catch (e: any) {
        if (wantsJson(req) || !(e instanceof HttpError)) throw e;
        const back = String(req.headers.referer ?? '/admin');
        const u = new URL(back, config.publicBaseUrl);
        u.searchParams.delete('ok');
        u.searchParams.set('err', e.message);
        res.redirect(303, u.pathname + u.search);
      }
    });
  const settingsUrl = (branchId: string) => `/admin/settings?branch=${branchId}`;
  const page = (req: Request, title: string, body: any, branch?: Row) =>
    SV.staffLayout({ title, staff: staffOf(req), body, branch, flash: flash(req), scripts: ['/js/staff.js'] }).value;

  // ---------------- daily overview ----------------
  r.get('/admin', requireRole('manager'), (req, res) => {
    const { branch, branches } = branchFor(req);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? String(req.query.date) : businessDate();
    const filter = ['all', 'paid', 'open', 'closed', 'print', 'adjusted'].includes(String(req.query.filter)) ? String(req.query.filter) : 'all';
    const g = (sql: string, ...p: any[]) => db.get<any>(sql, branch.id, date, ...p);
    const stats = {
      submitted: g('SELECT count(*) n FROM orders WHERE branch_id = ? AND business_date = ?').n,
      paid: g(`SELECT count(*) n FROM orders WHERE branch_id = ? AND business_date = ? AND status = 'paid'`).n,
      sales_paise: g(`SELECT coalesce(sum(final_total_paise),0) n FROM orders WHERE branch_id = ? AND business_date = ? AND status = 'paid' AND payment_status = 'paid'`).n,
      open: g(`SELECT count(*) n FROM orders WHERE branch_id = ? AND business_date = ? AND status IN ('awaiting_payment','in_progress')`).n,
      cancelled: g(`SELECT count(*) n FROM orders WHERE branch_id = ? AND business_date = ? AND status = 'cancelled'`).n,
      expired: g(`SELECT count(*) n FROM orders WHERE branch_id = ? AND business_date = ? AND status = 'expired'`).n,
      avg_minutes: (() => {
        const v = g(`SELECT avg((julianday(paid_at) - julianday(created_at)) * 1440) n FROM orders WHERE branch_id = ? AND business_date = ? AND status = 'paid'`).n;
        return v == null ? null : Math.round(v * 10) / 10;
      })(),
      print_failures: g(`SELECT count(DISTINCT j.order_id) n FROM print_jobs j JOIN orders o ON o.id = j.order_id WHERE o.branch_id = ? AND o.business_date = ? AND j.status IN ('failed','unknown')`).n,
      adjusted: g(`SELECT count(DISTINCT e.order_id) n FROM order_events e JOIN orders o ON o.id = e.order_id WHERE o.branch_id = ? AND o.business_date = ? AND e.type IN ('line_qty','line_removed','line_added')`).n,
    };
    const where: Record<string, string> = {
      all: '1=1', paid: `o.status = 'paid'`, open: `o.status IN ('awaiting_payment','in_progress')`, closed: `o.status IN ('cancelled','expired')`,
      print: `EXISTS (SELECT 1 FROM print_jobs j WHERE j.order_id = o.id AND j.status IN ('failed','unknown'))`,
      adjusted: `EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.type IN ('line_qty','line_removed','line_added'))`,
    };
    const list = db.all<Row>(`SELECT o.* FROM orders o WHERE o.branch_id = ? AND o.business_date = ? AND ${where[filter]} ORDER BY o.created_at DESC LIMIT 500`, branch.id, date);
    res.send(page(req, 'Overview', AV.overviewPage({ branch, branches, date, stats, orders: list, filter }), branch));
  });

  // ---------------- reconciliation ----------------
  r.get('/admin/reconcile', requireRole('manager'), asyncH(async (req, res) => {
    const { branch, branches } = branchFor(req);
    const since = addSeconds(nowIso(), -2 * 86400);
    const missingPos = db.all<Row>(`SELECT * FROM orders WHERE branch_id = ? AND pos_ref IS NULL AND status IN ('awaiting_payment','in_progress') ORDER BY created_at`, branch.id);
    let posPaidNotWeb: any[] = [];
    const posHealth = await ctx.pos.health();
    try {
      const sales = await ctx.pos.listSalesSince(since);
      for (const sale of sales) {
        const o = db.get<Row>(`SELECT * FROM orders WHERE branch_id = ? AND (payment_attempt_key = ? OR pos_ref = ?) AND status != 'paid'`, branch.id, sale.attempt_key, sale.pos_ref);
        if (o) posPaidNotWeb.push({ order: o, sale });
      }
    } catch (e: any) {
      posPaidNotWeb = [];
      posHealth.ok = false;
      posHealth.detail = `Could not list POS sales: ${e.message}`;
    }
    const printIssues = db.all<Row>(
      `SELECT j.*, o.code FROM print_jobs j LEFT JOIN orders o ON o.id = j.order_id WHERE j.branch_id = ? AND j.status IN ('failed','unknown') AND j.created_at > ?
       AND (j.order_id IS NULL OR NOT EXISTS (SELECT 1 FROM print_jobs k WHERE k.order_id = j.order_id AND k.created_at > j.created_at AND k.status IN ('sent','printed')))
       ORDER BY j.created_at DESC`, branch.id, since);
    const pendingPayments = db.all<Row>(`SELECT * FROM orders WHERE branch_id = ? AND payment_status = 'pending'`, branch.id);
    const deadOutbox = db.all<Row>(`SELECT x.* FROM outbox x JOIN orders o ON o.id = x.ref_id WHERE o.branch_id = ? AND x.status = 'dead'`, branch.id);
    res.send(page(req, 'Reconcile', AV.reconcilePage({ branch, branches, missingPos, posPaidNotWeb, printIssues, pendingPayments, deadOutbox, csrf: staffOf(req).csrf, posHealth }), branch));
  }));

  r.post('/admin/reconcile/retry-pos/:id', requireRole('manager'), action(async (req, res) => {
    const o = orders.byId(String(req.params.id));
    if (!o) throw new HttpError(404, 'NOT_FOUND', 'Order not found');
    assertBranch(staffOf(req), o.branch_id);
    db.run(`UPDATE outbox SET status = 'pending', next_attempt_at = ? WHERE kind = 'pos_submit' AND ref_id = ?`, nowIso(), o.id);
    audit(req, 'retry_pos', o.id);
    await worker?.processOutbox();
    done(req, res, `/admin/reconcile?branch=${o.branch_id}`, {}, `Retried ${o.code}`);
  }));

  // ---------------- catalogue ----------------
  r.get('/admin/catalogue', requireRole('manager'), (req, res) => {
    const result = req.query.import ? db.get<Row>('SELECT * FROM catalogue_syncs WHERE id = ?', Number(req.query.import)) : undefined;
    res.send(page(req, 'Catalogue', AV.cataloguePage({
      last: catalogue.lastSync(), lastOk: catalogue.lastSuccessfulSync(), dups: catalogue.duplicateBarcodes(), review: catalogue.needsReview(),
      counts: db.get<Row>('SELECT sum(active) active, sum(active AND NOT available) unavailable FROM items')!, csrf: staffOf(req).csrf,
      result: result ? { stats: JSON.parse(result.stats), issues: JSON.parse(result.issues) } : undefined, posName: ctx.pos.name,
    })));
  });
  r.post('/admin/catalogue/sync', requireRole('manager'), action(async (req, res) => {
    try {
      const r2 = await catalogue.syncFromPos(ctx.pos, { isDemo: config.demoMode });
      audit(req, 'catalogue_sync', 'pos', r2.stats);
      done(req, res, `/admin/catalogue?import=${r2.syncId}`, r2 as any, `Synced: ${r2.stats.inserted} new, ${r2.stats.updated} updated, ${r2.issues.length} issue(s)`);
    } catch (e: any) {
      throw new HttpError(502, 'SYNC_FAILED', `POS sync failed: ${e.message}`);
    }
  }));
  r.post('/admin/catalogue/import', requireRole('manager'), action((req, res) => {
    const text = String(req.body?.csv ?? '');
    if (!text.trim()) throw new HttpError(400, 'EMPTY', 'The file is empty');
    if (text.length > 15 * 1024 * 1024) throw new HttpError(413, 'TOO_BIG', 'File too large (max 15 MB)');
    const { items, errors } = csvRowsToItems(parseCsv(text));
    const result = catalogue.upsertItems(items, 'csv', { isDemo: config.demoMode });
    if (errors.length) {
      const issues = [...errors, ...result.issues];
      db.run(`UPDATE catalogue_syncs SET issues = ?, status = 'partial' WHERE id = ?`, JSON.stringify(issues.slice(0, 500)), result.syncId);
    }
    audit(req, 'catalogue_import', 'csv', result.stats);
    done(req, res, `/admin/catalogue?import=${result.syncId}`, { syncId: result.syncId, stats: result.stats, errors: errors.length });
  }));
  r.get('/admin/catalogue/template.csv', requireRole('manager'), (_req, res) => {
    res.type('text/csv').attachment('mpc-catalogue-template.csv').send(
      'pos_item_id,name_en,name_ta,brand,department,pack_label,sold_by,price,mrp,barcodes,available,group_key,max_qty,aliases,image_url\n' +
      'P1001,Toned Milk,டோன்ட் பால்,,dairy,500 ml,pack,27.00,,8901234567890,1,toned-milk,10,paal|milk,\n' +
      'V2001,Tomato,தக்காளி,,vegetables,per kg,weight,40.00,,,1,,,thakkali,\n',
    );
  });

  // ---------------- settings ----------------
  r.get('/admin/settings', requireRole('manager'), asyncH(async (req, res) => {
    const { branch, branches } = branchFor(req);
    const qrUrl = `${config.publicBaseUrl}/s/${branch.slug}`;
    const newAgentToken = typeof req.query.agent_token === 'string' ? req.query.agent_token : undefined;
    res.send(page(req, 'Settings', AV.settingsPage({
      branch, branches, counters: orders.counters(branch.id), printers: db.all<Row>('SELECT * FROM printers WHERE branch_id = ? ORDER BY name', branch.id),
      agents: db.all<Row>('SELECT * FROM print_agents WHERE branch_id = ? ORDER BY name', branch.id), printerStatus: print.printerStatus(branch.id),
      csrf: staffOf(req).csrf, newAgentToken, qrSvg: await QRCode.toString(qrUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0B5A2A', light: '#FFFFFF' } }),
      qrUrl, canEdit: true,
      recentJobs: db.all<Row>('SELECT j.*, o.code FROM print_jobs j LEFT JOIN orders o ON o.id = j.order_id WHERE j.branch_id = ? ORDER BY j.created_at DESC LIMIT 15', branch.id),
    }), branch));
  }));

  r.post('/admin/branches/:id/accepting', requireRole('manager'), action((req, res) => {
    const b = branchParam(req);
    const accepting = req.body?.accepting === '1' ? 1 : 0;
    db.run('UPDATE branches SET accepting_orders = ?, pause_message_en = ?, pause_message_ta = ? WHERE id = ?', accepting,
      String(req.body?.pause_message_en ?? '').slice(0, 300) || null, String(req.body?.pause_message_ta ?? '').slice(0, 300) || null, b.id);
    audit(req, accepting ? 'resume_scan_shop' : 'pause_scan_shop', b.id);
    done(req, res, settingsUrl(b.id), {}, accepting ? 'Scan & Shop resumed' : 'Scan & Shop paused for new baskets');
  }));
  r.post('/admin/branches/:id/routing', requireRole('manager'), action((req, res) => {
    const b = branchParam(req);
    const routing = ['default', 'least_busy', 'round_robin'].includes(req.body?.routing) ? req.body.routing : 'default';
    const def = orders.counter(String(req.body?.default_counter_id ?? ''));
    const expiry = Math.min(720, Math.max(15, Number(req.body?.expiry_minutes) || b.expiry_minutes));
    const maxOpen = Math.min(500, Math.max(1, Number(req.body?.max_open_orders) || b.max_open_orders));
    db.run('UPDATE branches SET routing = ?, default_counter_id = ?, expiry_minutes = ?, max_open_orders = ? WHERE id = ?', routing, def && def.branch_id === b.id ? def.id : b.default_counter_id, expiry, maxOpen, b.id);
    audit(req, 'routing', b.id, { routing, expiry, maxOpen });
    done(req, res, settingsUrl(b.id), {}, 'Saved');
  }));
  r.post('/admin/branches/:id/counters', requireRole('manager'), action((req, res) => {
    const b = branchParam(req);
    const n = Math.floor(Number(req.body?.number));
    if (!(n >= 1 && n <= 99)) throw new HttpError(400, 'BAD', 'Counter number 1-99');
    if (db.get('SELECT 1 FROM counters WHERE branch_id = ? AND number = ?', b.id, n)) throw new HttpError(409, 'EXISTS', `Counter ${n} already exists`);
    db.run('INSERT INTO counters (id, branch_id, number, name) VALUES (?,?,?,?)', newId('ctr'), b.id, n, `Counter ${n}`);
    audit(req, 'add_counter', b.id, { n });
    done(req, res, settingsUrl(b.id), {}, `Counter ${n} added`);
  }));
  r.post('/admin/counters/:cid', requireRole('manager'), action((req, res) => {
    const c = orders.counter(String(req.params.cid));
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Counter not found');
    assertBranch(staffOf(req), c.branch_id);
    const printer = req.body?.printer_id ? db.get<Row>('SELECT * FROM printers WHERE id = ? AND branch_id = ?', String(req.body.printer_id), c.branch_id) : undefined;
    db.run('UPDATE counters SET active = ?, printer_id = ? WHERE id = ?', req.body?.active === '1' ? 1 : 0, printer?.id ?? null, c.id);
    audit(req, 'counter', c.id, { active: req.body?.active, printer: printer?.id });
    done(req, res, settingsUrl(c.branch_id), {}, `Counter ${c.number} saved`);
  }));
  r.post('/admin/branches/:id/printers', requireRole('manager'), action((req, res) => {
    const b = branchParam(req);
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, 'BAD', 'Name required');
    db.run('INSERT INTO printers (id, branch_id, name) VALUES (?,?,?)', newId('prn'), b.id, name);
    done(req, res, settingsUrl(b.id), {}, 'Printer added');
  }));
  r.post('/admin/printers/:pid', requireRole('manager'), action((req, res) => {
    const p = db.get<Row>('SELECT * FROM printers WHERE id = ?', String(req.params.pid));
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Printer not found');
    assertBranch(staffOf(req), p.branch_id);
    const agent = req.body?.agent_id ? db.get<Row>('SELECT * FROM print_agents WHERE id = ? AND branch_id = ?', String(req.body.agent_id), p.branch_id) : undefined;
    db.run('UPDATE printers SET paper_width_mm = ?, language = ?, agent_id = ? WHERE id = ?', Number(req.body?.paper_width_mm) === 58 ? 58 : 80, req.body?.language === 'ta' ? 'ta' : 'en', agent?.id ?? null, p.id);
    audit(req, 'printer', p.id, req.body);
    done(req, res, settingsUrl(p.branch_id), {}, 'Printer saved');
  }));
  r.post('/admin/printers/:pid/test', requireRole('manager'), action((req, res) => {
    const p = db.get<Row>('SELECT * FROM printers WHERE id = ?', String(req.params.pid));
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'Printer not found');
    assertBranch(staffOf(req), p.branch_id);
    const branch = orders.branch(p.branch_id)!;
    const counter = db.get<Row>('SELECT * FROM counters WHERE printer_id = ? LIMIT 1', p.id) ?? { id: null, printer_id: p.id, number: 0 };
    const id = print.createJob({ branch, counter, kind: 'test', doc: print.buildTestSlip(branch, p, staffOf(req).display_name), createdBy: staffOf(req).id });
    done(req, res, settingsUrl(p.branch_id), { job: id }, 'Test slip queued — check the printer');
  }));
  r.post('/admin/branches/:id/agents', requireRole('manager'), action((req, res) => {
    const b = branchParam(req);
    const name = String(req.body?.name ?? '').trim().slice(0, 60) || 'Print agent';
    const token = `mpcagent_${randomToken(32)}`;
    const id = newId('agt');
    db.run('INSERT INTO print_agents (id, branch_id, name, token_hash) VALUES (?,?,?,?)', id, b.id, name, sha256(token));
    audit(req, 'agent_created', id);
    if (wantsJson(req)) return res.json({ ok: true, id, token });
    res.redirect(303, `${settingsUrl(b.id)}&agent_token=${encodeURIComponent(token)}`);
  }));
  r.post('/admin/agents/:aid/rotate', requireRole('manager'), action((req, res) => {
    const a = db.get<Row>('SELECT * FROM print_agents WHERE id = ?', String(req.params.aid));
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'Agent not found');
    assertBranch(staffOf(req), a.branch_id);
    const token = `mpcagent_${randomToken(32)}`;
    db.run('UPDATE print_agents SET token_hash = ? WHERE id = ?', sha256(token), a.id);
    audit(req, 'agent_token_rotated', a.id);
    res.redirect(303, `${settingsUrl(a.branch_id)}&agent_token=${encodeURIComponent(token)}`);
  }));
  r.post('/admin/branches/:id/scale-rules', requireRole('manager'), action((req, res) => {
    const b = branchParam(req);
    const text = String(req.body?.rules ?? '').trim() || '[]';
    let rules;
    try {
      rules = validateScaleRules(JSON.parse(text));
    } catch (e: any) {
      throw new HttpError(400, 'BAD_RULES', `Scale rules not saved: ${e.message}`);
    }
    db.run('UPDATE branches SET scale_label_rules = ? WHERE id = ?', JSON.stringify(rules, null, 1), b.id);
    audit(req, 'scale_rules', b.id, rules);
    done(req, res, settingsUrl(b.id), {}, 'Scale label rules saved');
  }));
  r.post('/admin/branches/:id/store-info', requireRole('owner'), action((req, res) => {
    const b = branchParam(req);
    const body = req.body ?? {};
    const hours = String(body.hours ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(.+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (!m) throw new HttpError(400, 'BAD_HOURS', `Hours line not understood: "${l}" (use e.g. Mon-Sun 07:00-22:00)`);
      return { days: m[1], open: m[2], close: m[3] };
    });
    const dayMap: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
    const order = Object.keys(dayMap);
    const hours_spec = hours.map((h) => {
      const [a, z] = h.days.toLowerCase().split('-').map((d) => d.trim().slice(0, 3));
      const ia = order.indexOf(a);
      const iz = z ? order.indexOf(z) : ia;
      const days = ia >= 0 && iz >= 0 ? order.slice(ia, iz + 1).map((d) => dayMap[d]) : [];
      return { '@type': 'OpeningHoursSpecification', dayOfWeek: days, opens: h.open, closes: h.close };
    });
    const url = String(body.map_url ?? '').trim();
    if (url && !/^https:\/\//.test(url)) throw new HttpError(400, 'BAD_URL', 'Map link must start with https://');
    const info = {
      verified: body.verified === '1', address: String(body.address ?? '').trim(), locality: String(body.locality ?? '').trim(), postal_code: String(body.postal_code ?? '').trim(),
      phone: String(body.phone ?? '').trim(), hours, hours_spec, map_url: url,
      geo: body.lat && body.lng ? { lat: Number(body.lat), lng: Number(body.lng) } : null,
    };
    db.run('UPDATE branches SET name_en = ?, name_ta = ?, store_info = ? WHERE id = ?', String(body.name_en ?? b.name_en).trim() || b.name_en, String(body.name_ta ?? '').trim() || null, JSON.stringify(info), b.id);
    audit(req, 'store_info', b.id, info);
    done(req, res, settingsUrl(b.id), {}, 'Store details saved');
  }));

  // ---------------- QR code & sign ----------------
  r.get('/admin/branches/:id/qr.svg', requireRole('manager'), asyncH(async (req, res) => {
    const b = branchParam(req);
    res.type('image/svg+xml').attachment(`mpc-${b.slug}-entrance-qr.svg`).send(await QRCode.toString(`${config.publicBaseUrl}/s/${b.slug}`, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
  }));
  r.get('/admin/branches/:id/qr.png', requireRole('manager'), asyncH(async (req, res) => {
    const b = branchParam(req);
    res.type('image/png').attachment(`mpc-${b.slug}-entrance-qr.png`).send(await QRCode.toBuffer(`${config.publicBaseUrl}/s/${b.slug}`, { width: 1200, margin: 2, errorCorrectionLevel: 'M' }));
  }));
  r.get('/admin/branches/:id/sign', requireRole('manager'), asyncH(async (req, res) => {
    const b = branchParam(req);
    const url = `${config.publicBaseUrl}/s/${b.slug}`;
    res.send(AV.signPage({ branch: b, url, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0B5A2A', light: '#FFFFFF' } }) }).value);
  }));

  // ---------------- staff management ----------------
  r.get('/admin/staff', requireRole('owner'), (req, res) => {
    res.send(page(req, 'Staff', AV.staffAdminPage({ staff: db.all<Row>('SELECT * FROM staff ORDER BY role, display_name'), branches: orders.branches(), csrf: staffOf(req).csrf })));
  });
  r.post('/admin/staff', requireRole('owner'), action((req, res) => {
    const b = req.body ?? {};
    const username = String(b.username ?? '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpError(400, 'BAD', 'Username: 3-32 lowercase letters, digits, . _ -');
    if (String(b.password ?? '').length < 8) throw new HttpError(400, 'BAD', 'Password must be at least 8 characters');
    if (!['cashier', 'manager', 'owner'].includes(b.role)) throw new HttpError(400, 'BAD', 'Choose a role');
    if (db.get('SELECT 1 FROM staff WHERE username = ?', username)) throw new HttpError(409, 'EXISTS', 'Username already taken');
    const branchIds = b.branch === '*' ? '*' : JSON.stringify([String(b.branch)]);
    db.run('INSERT INTO staff (id, username, display_name, role, branch_ids, password_hash) VALUES (?,?,?,?,?,?)',
      newId('stf'), username, String(b.display_name ?? username).slice(0, 60), b.role, branchIds, hashPassword(String(b.password)));
    audit(req, 'staff_created', username, { role: b.role });
    done(req, res, '/admin/staff', {}, `Created ${username}`);
  }));
  r.post('/admin/staff/:sid/toggle', requireRole('owner'), action((req, res) => {
    const s = db.get<Row>('SELECT * FROM staff WHERE id = ?', String(req.params.sid));
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    if (s.id === staffOf(req).id) throw new HttpError(400, 'SELF', 'You cannot disable yourself');
    db.run('UPDATE staff SET active = 1 - active WHERE id = ?', s.id);
    if (s.active) db.run('DELETE FROM sessions WHERE staff_id = ?', s.id);
    audit(req, 'staff_toggle', s.id);
    done(req, res, '/admin/staff');
  }));
  r.post('/admin/staff/:sid/password', requireRole('owner'), action((req, res) => {
    const s = db.get<Row>('SELECT * FROM staff WHERE id = ?', String(req.params.sid));
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    if (String(req.body?.password ?? '').length < 8) throw new HttpError(400, 'BAD', 'Password must be at least 8 characters');
    db.run('UPDATE staff SET password_hash = ? WHERE id = ?', hashPassword(String(req.body.password)), s.id);
    db.run('DELETE FROM sessions WHERE staff_id = ?', s.id);
    audit(req, 'staff_password', s.id);
    done(req, res, '/admin/staff', {}, 'Password changed');
  }));

  // ---------------- demo tools ----------------
  r.get('/admin/demo', requireRole('manager'), (req, res) => {
    if (!config.demoMode || !ctx.sim) throw new HttpError(404, 'NOT_FOUND', 'Demo tools are only available in demo mode');
    res.send(page(req, 'Demo tools', AV.demoPage({ csrf: staffOf(req).csrf, fault: ctx.sim.fault, items: db.all<Row>('SELECT * FROM items WHERE active = 1 ORDER BY name_en'), branch: branchFor(req).branch })));
  });
  r.post('/admin/demo/fault', requireRole('manager'), action((req, res) => {
    if (!config.demoMode || !ctx.sim) throw new HttpError(404, 'NOT_FOUND', 'Demo only');
    const f = ['none', 'down', 'timeout_after_commit'].includes(req.body?.fault) ? req.body.fault : 'none';
    ctx.sim.setFault(f, f === 'timeout_after_commit' ? 1 : Infinity);
    done(req, res, '/admin/demo', {}, `POS simulator: ${f}`);
  }));
  r.post('/admin/demo/price', requireRole('manager'), action(async (req, res) => {
    if (!config.demoMode || !ctx.sim) throw new HttpError(404, 'NOT_FOUND', 'Demo only');
    let paise: number;
    try {
      paise = parseRupeesToPaise(String(req.body?.price));
    } catch {
      throw new HttpError(400, 'BAD', 'Enter a price like 42 or 42.50');
    }
    ctx.sim.setPrice(String(req.body?.pos_item_id), paise);
    await catalogue.syncFromPos(ctx.pos, { isDemo: true });
    done(req, res, '/admin/demo', {}, 'Price changed at the POS and synced');
  }));

  return r;
}
