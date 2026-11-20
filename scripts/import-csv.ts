import fs from 'node:fs';
import { createContext } from '../src/context.js';
import { csvRowsToItems, parseCsv } from '../src/catalogue/service.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run import:csv -- path/to/catalogue.csv');
  process.exit(1);
}
const ctx = createContext();
const { items, errors } = csvRowsToItems(parseCsv(fs.readFileSync(file, 'utf8')));
const r = ctx.catalogue.upsertItems(items, 'csv');
console.log(JSON.stringify(r.stats, null, 2));
for (const e of [...errors, ...r.issues].slice(0, 200)) console.log(' -', (e as any).row ? `row ${(e as any).row}:` : '', (e as any).pos_item_id ?? '', e.problem);
ctx.db.close();
