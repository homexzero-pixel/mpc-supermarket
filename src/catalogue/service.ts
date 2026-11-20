import type { Db } from '../db/index.js';
import type { PosAdapter, PosCatalogueItem } from '../pos/adapter.js';
import { barcodeVariants, normaliseBarcode, parseScaleLabel, type ScaleLabelRule } from '../lib/barcode.js';
import { nowIso, slugify } from '../lib/util.js';

export interface Item {
  id: number;
  pos_item_id: string;
  slug: string;
  group_key: string | null;
  name_en: string;
  name_ta: string | null;
  brand: string | null;
  department: string | null;
  pack_label: string | null;
  sold_by: 'pack' | 'piece' | 'weight';
  price_paise: number;
  mrp_paise: number | null;
  max_qty: number;
  available: number;
  active: number;
  image_url: string | null;
  aliases: string;
  is_demo: number;
}

export const DEFAULT_DEPARTMENTS: [string, string, string, string][] = [
  ['fruits', 'Fruits', 'பழங்கள்', '#FFF1C9'],
  ['vegetables', 'Vegetables', 'காய்கறிகள்', '#E3F1DA'],
  ['rice-grains', 'Rice & Grains', 'அரிசி & தானியங்கள்', '#F4EAD8'],
  ['dals-pulses', 'Dals & Pulses', 'பருப்பு வகைகள்', '#FBE3CF'],
  ['dairy', 'Dairy & Eggs', 'பால் & முட்டை', '#E6EEF7'],
  ['oils-masala', 'Oils & Masala', 'எண்ணெய் & மசாலா', '#FCE9C2'],
  ['snacks', 'Snacks', 'தின்பண்டங்கள்', '#F9E0DC'],
  ['beverages', 'Beverages', 'பானங்கள்', '#DFF1EE'],
  ['personal-care', 'Personal Care', 'தனிநபர் பராமரிப்பு', '#EDE6F5'],
  ['household', 'Household', 'வீட்டு உபயோகம்', '#E8ECEF'],
];

export class CatalogueService {
  constructor(private db: Db) {}

  ensureDepartments() {
    DEFAULT_DEPARTMENTS.forEach(([slug, en, ta, color], i) =>
      this.db.run('INSERT OR IGNORE INTO departments (slug, name_en, name_ta, sort, color) VALUES (?,?,?,?,?)', slug, en, ta, i * 10, color),
    );
  }

  /** Only departments that actually have active products. */
  activeDepartments() {
    return this.db.all<{ slug: string; name_en: string; name_ta: string; color: string; n: number }>(
      `SELECT d.slug, d.name_en, d.name_ta, d.color, count(i.id) n FROM departments d
       JOIN items i ON i.department = d.slug AND i.active = 1 GROUP BY d.slug ORDER BY d.sort`,
    );
  }
  department(slug: string) {
    return this.db.get<{ slug: string; name_en: string; name_ta: string; color: string }>('SELECT * FROM departments WHERE slug = ?', slug);
  }

  byId(id: number) {
    return this.db.get<Item>('SELECT * FROM items WHERE id = ?', id);
  }
  bySlug(slug: string) {
    return this.db.get<Item>('SELECT * FROM items WHERE slug = ? AND active = 1', slug);
  }
  byIds(ids: number[]) {
    if (!ids.length) return [];
    return this.db.all<Item>(`SELECT * FROM items WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  }
  related(item: Item) {
    if (!item.group_key) return [];
    return this.db.all<Item>('SELECT * FROM items WHERE group_key = ? AND id != ? AND active = 1 ORDER BY price_paise', item.group_key, item.id);
  }
  inDepartment(slug: string, limit = 24, offset = 0) {
    return this.db.all<Item>('SELECT * FROM items WHERE department = ? AND active = 1 ORDER BY available DESC, name_en LIMIT ? OFFSET ?', slug, limit, offset);
  }
  countInDepartment(slug: string) {
    return this.db.get<{ n: number }>('SELECT count(*) n FROM items WHERE department = ? AND active = 1', slug)!.n;
  }
  featured(limit = 8) {
    return this.db.all<Item>(`SELECT * FROM items WHERE active = 1 AND available = 1 ORDER BY (department IN ('fruits','vegetables')) DESC, id LIMIT ?`, limit);
  }

  /**
   * Exact barcode lookup. Returns all matches so the caller can handle
   * ambiguity explicitly (never silently picks the "nearest" product).
   */
  lookupBarcode(raw: string, scaleRules: ScaleLabelRule[] = []) {
    const code = normaliseBarcode(raw);
    if (!code) return { kind: 'unknown' as const, code, items: [] as Item[] };
    const variants = barcodeVariants(code);
    const items = this.db.all<Item>(
      `SELECT DISTINCT i.* FROM item_barcodes b JOIN items i ON i.id = b.item_id
       WHERE b.barcode IN (${variants.map(() => '?').join(',')}) AND i.active = 1`,
      ...variants,
    );
    if (items.length) return { kind: items.length === 1 ? ('exact' as const) : ('ambiguous' as const), code, items };
    const scale = parseScaleLabel(code, scaleRules);
    if (scale) {
      const plu = this.db.all<Item>(`SELECT i.* FROM item_barcodes b JOIN items i ON i.id = b.item_id WHERE b.barcode = ? AND i.active = 1`, `plu:${scale.plu}`);
      if (plu.length === 1) return { kind: 'scale' as const, code, items: plu, scale };
      if (plu.length > 1) return { kind: 'ambiguous' as const, code, items: plu, scale };
    }
    return { kind: 'unknown' as const, code, items: [] as Item[] };
  }

  /** Ranked search: barcode > exact name > prefix > trigram (handles spelling variations). */
  search(q: string, limit = 20, offset = 0): { items: Item[]; total: number } {
    const query = q.trim().toLowerCase().slice(0, 80);
    if (!query) return { items: [], total: 0 };
    if (/^\d{6,14}$/.test(query.replace(/\s/g, ''))) {
      const r = this.lookupBarcode(query);
      if (r.items.length) return { items: r.items.slice(offset, offset + limit), total: r.items.length };
    }
    const terms = query.split(/\s+/).filter(Boolean);
    const scores = new Map<number, number>();
    const add = (id: number, s: number) => scores.set(id, Math.max(scores.get(id) ?? 0, s));

    // 1) exact and prefix matches on names / aliases
    const like = this.db.all<{ id: number; name_en: string; name_ta: string | null; aliases: string; brand: string | null }>(
      `SELECT id, name_en, name_ta, aliases, brand FROM items WHERE active = 1 AND (
         lower(name_en) LIKE ? OR lower(coalesce(name_ta,'')) LIKE ? OR lower(aliases) LIKE ? OR lower(coalesce(brand,'')) LIKE ?) LIMIT 500`,
      `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`,
    );
    for (const r of like) {
      const n = r.name_en.toLowerCase();
      const aliases = r.aliases.toLowerCase().split(/[,;|]/).map((a) => a.trim());
      if (n === query || aliases.includes(query) || (r.name_ta ?? '') === query) add(r.id, 100);
      else if (n.startsWith(query) || aliases.some((a) => a.startsWith(query))) add(r.id, 80);
      else if ((r.brand ?? '').toLowerCase().startsWith(query)) add(r.id, 70);
      else add(r.id, 60);
    }
    // 2) trigram full-text (substring match per term; terms shorter than 3 chars are skipped)
    const ftsTerms = terms.filter((t) => [...t].length >= 3).map((t) => `"${t.replace(/"/g, '')}"`);
    if (ftsTerms.length) {
      try {
        for (const r of this.db.all<{ id: number; rank: number }>(
          `SELECT rowid id, bm25(items_fts) rank FROM items_fts WHERE items_fts MATCH ? ORDER BY rank LIMIT 300`,
          ftsTerms.join(' AND '),
        )) add(r.id, 40);
      } catch { /* malformed query */ }
    }
    // 3) fuzzy fallback for misspellings ("tomoto", "bannana"): shared trigram count
    if (scores.size < 5 && [...query].length >= 4) {
      const grams = new Set<string>();
      const qq = query.replace(/\s+/g, ' ');
      for (let i = 0; i + 3 <= qq.length; i++) grams.add(qq.slice(i, i + 3));
      const ors = [...grams].map((g) => `"${g.replace(/"/g, '')}"`).join(' OR ');
      try {
        const rows = this.db.all<{ id: number; name_en: string; aliases: string }>(
          `SELECT i.id, i.name_en, i.aliases FROM items_fts f JOIN items i ON i.id = f.rowid WHERE items_fts MATCH ? AND i.active = 1 LIMIT 400`,
          ors,
        );
        for (const r of rows) {
          const hay = (r.name_en + ' ' + r.aliases).toLowerCase();
          let hit = 0;
          for (const g of grams) if (hay.includes(g)) hit++;
          const ratio = hit / grams.size;
          if (ratio >= 0.4) add(r.id, Math.round(ratio * 30));
        }
      } catch { /* ignore */ }
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const ids = ranked.slice(offset, offset + limit).map(([id]) => id);
    const byId = new Map(this.byIds(ids).map((i) => [i.id, i]));
    const items = ids.map((id) => byId.get(id)!).filter(Boolean).sort((a, b) => (scores.get(b.id)! - scores.get(a.id)!) || b.available - a.available);
    return { items, total: ranked.length };
  }

  /** Upsert catalogue rows (from POS sync or CSV import) and report data-quality issues. */
  upsertItems(rows: PosCatalogueItem[], source: 'pos' | 'csv', opts: { isDemo?: boolean; deactivateMissing?: boolean } = {}) {
    const started = nowIso();
    const syncId = Number(this.db.run(`INSERT INTO catalogue_syncs (source, started_at, status) VALUES (?, ?, 'running')`, source, started).lastInsertRowid);
    const issues: { pos_item_id?: string; row?: number; problem: string }[] = [];
    let inserted = 0, updated = 0, skipped = 0;
    const seen = new Set<string>();
    this.db.tx(() => {
      rows.forEach((r, idx) => {
        const problems: string[] = [];
        if (!r.pos_item_id) problems.push('missing POS item id');
        if (!r.name_en) problems.push('missing name');
        if (!['pack', 'piece', 'weight'].includes(r.sold_by)) problems.push(`invalid sold_by "${r.sold_by}"`);
        if (!Number.isSafeInteger(r.price_paise) || r.price_paise <= 0) problems.push('invalid price');
        if (problems.length) {
          issues.push({ pos_item_id: r.pos_item_id, row: idx + 1, problem: problems.join('; ') });
          skipped++;
          return;
        }
        if (seen.has(r.pos_item_id)) {
          issues.push({ pos_item_id: r.pos_item_id, row: idx + 1, problem: 'duplicate POS item id in source (later row ignored)' });
          skipped++;
          return;
        }
        seen.add(r.pos_item_id);
        if (r.sold_by === 'pack' && !r.pack_label) issues.push({ pos_item_id: r.pos_item_id, problem: 'pack item without pack size' });
        if (!r.barcodes?.length && r.sold_by !== 'weight') issues.push({ pos_item_id: r.pos_item_id, problem: 'no barcode (customers can only find it by search)' });
        const existing = this.db.get<{ id: number; slug: string }>('SELECT id, slug FROM items WHERE pos_item_id = ?', r.pos_item_id);
        const fields = [
          r.group_key ?? null, r.name_en.trim(), r.name_ta ?? null, r.brand ?? null, r.department ?? null, r.pack_label ?? null,
          r.sold_by, r.price_paise, r.mrp_paise ?? null, r.max_qty ?? 20, r.available ? 1 : 0, r.image_url ?? null, r.aliases ?? '',
        ] as const;
        let id: number;
        if (existing) {
          this.db.run(
            `UPDATE items SET group_key=?, name_en=?, name_ta=?, brand=?, department=?, pack_label=?, sold_by=?, price_paise=?, mrp_paise=?,
             max_qty=?, available=?, image_url=?, aliases=?, active=1, updated_at=? WHERE id=?`,
            ...fields, nowIso(), existing.id,
          );
          id = existing.id;
          updated++;
        } else {
          let slug = slugify(`${r.name_en} ${r.pack_label ?? ''}`);
          if (this.db.get('SELECT 1 FROM items WHERE slug = ?', slug)) slug = `${slug}-${slugify(r.pos_item_id)}`;
          id = Number(
            this.db.run(
              `INSERT INTO items (group_key, name_en, name_ta, brand, department, pack_label, sold_by, price_paise, mrp_paise, max_qty, available,
               image_url, aliases, pos_item_id, slug, is_demo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              ...fields, r.pos_item_id, slug, opts.isDemo ? 1 : 0,
            ).lastInsertRowid,
          );
          inserted++;
        }
        this.db.run('DELETE FROM item_barcodes WHERE item_id = ?', id);
        for (const b of r.barcodes ?? []) {
          const code = normaliseBarcode(String(b));
          if (code) this.db.run('INSERT OR IGNORE INTO item_barcodes (barcode, item_id) VALUES (?, ?)', code, id);
        }
      });
      if (opts.deactivateMissing && seen.size) {
        const res = this.db.run(
          `UPDATE items SET active = 0 WHERE active = 1 AND pos_item_id NOT IN (${[...seen].map(() => '?').join(',')})`,
          ...seen,
        );
        if (res.changes) issues.push({ problem: `${res.changes} item(s) no longer in POS were hidden` });
      }
    });
    for (const d of this.duplicateBarcodes()) issues.push({ problem: `barcode ${d.barcode} is shared by ${d.n} products: ${d.names}` });
    const status = issues.some((i) => i.row) ? 'partial' : 'ok';
    const stats = { received: rows.length, inserted, updated, skipped };
    this.db.run('UPDATE catalogue_syncs SET finished_at = ?, status = ?, stats = ?, issues = ? WHERE id = ?', nowIso(), status, JSON.stringify(stats), JSON.stringify(issues.slice(0, 500)), syncId);
    return { syncId, status, stats, issues };
  }

  async syncFromPos(pos: PosAdapter, opts: { isDemo?: boolean } = {}) {
    try {
      const rows = await pos.fetchCatalogue();
      return this.upsertItems(rows, 'pos', { isDemo: opts.isDemo, deactivateMissing: true });
    } catch (e: any) {
      this.db.run(`INSERT INTO catalogue_syncs (source, started_at, finished_at, status, issues) VALUES ('pos', ?, ?, 'failed', ?)`, nowIso(), nowIso(), JSON.stringify([{ problem: e.message }]));
      throw e;
    }
  }

  duplicateBarcodes() {
    return this.db.all<{ barcode: string; n: number; names: string }>(
      `SELECT b.barcode, count(*) n, group_concat(i.name_en || ' ' || coalesce(i.pack_label,''), ' / ') names
       FROM item_barcodes b JOIN items i ON i.id = b.item_id WHERE i.active = 1 AND b.barcode NOT LIKE 'plu:%' GROUP BY b.barcode HAVING n > 1`,
    );
  }
  lastSync() {
    return this.db.get<any>(`SELECT * FROM catalogue_syncs WHERE status != 'running' ORDER BY id DESC LIMIT 1`);
  }
  lastSuccessfulSync() {
    return this.db.get<any>(`SELECT * FROM catalogue_syncs WHERE status IN ('ok','partial') ORDER BY id DESC LIMIT 1`);
  }
  needsReview() {
    return this.db.all<Item & { problem: string }>(
      `SELECT i.*, CASE
         WHEN i.sold_by = 'pack' AND (i.pack_label IS NULL OR i.pack_label = '') THEN 'Missing pack size'
         WHEN i.sold_by != 'weight' AND NOT EXISTS (SELECT 1 FROM item_barcodes b WHERE b.item_id = i.id) THEN 'No barcode'
         WHEN i.image_url IS NULL THEN 'No photo (using illustration)'
       END problem
       FROM items i WHERE i.active = 1 AND problem IS NOT NULL ORDER BY problem, i.name_en LIMIT 200`,
    );
  }
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim().replace(/^﻿/, '').toLowerCase());
  return data.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/**
 * Convert CSV rows to catalogue items. Expected headers (case-insensitive):
 * pos_item_id,name_en,name_ta,brand,department,pack_label,sold_by,price,mrp,barcodes,available,group_key,max_qty,aliases,image_url
 * price/mrp are in rupees (e.g. 42.50). barcodes separated by | or ;
 * Barcodes are kept as text: if your spreadsheet stripped leading zeros, fix them before import.
 */
export function csvRowsToItems(rows: Record<string, string>[]): { items: PosCatalogueItem[]; errors: { row: number; problem: string }[] } {
  const items: PosCatalogueItem[] = [];
  const errors: { row: number; problem: string }[] = [];
  const toPaise = (s: string) => {
    const m = s.replace(/[₹,\s]/g, '').match(/^(\d+)(?:\.(\d{1,2}))?$/);
    return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0) : NaN;
  };
  rows.forEach((r, i) => {
    const price = toPaise(r.price ?? '');
    if (Number.isNaN(price)) { errors.push({ row: i + 2, problem: `invalid price "${r.price}"` }); return; }
    const barcodes = (r.barcodes ?? r.barcode ?? '').split(/[|;]/).map((b) => b.trim()).filter(Boolean);
    if (barcodes.some((b) => /e\+/i.test(b))) { errors.push({ row: i + 2, problem: 'barcode in scientific notation (spreadsheet corrupted it)' }); return; }
    items.push({
      pos_item_id: r.pos_item_id,
      name_en: r.name_en ?? r.name,
      name_ta: r.name_ta || null,
      brand: r.brand || null,
      department: r.department || null,
      pack_label: r.pack_label || null,
      sold_by: (r.sold_by || 'pack') as any,
      price_paise: price,
      mrp_paise: r.mrp ? toPaise(r.mrp) || null : null,
      barcodes,
      available: !['0', 'false', 'no', 'n'].includes((r.available ?? '1').toLowerCase()),
      group_key: r.group_key || null,
      max_qty: r.max_qty ? Number(r.max_qty) : null,
      aliases: r.aliases || '',
      image_url: r.image_url || null,
    });
  });
  return { items, errors };
}
