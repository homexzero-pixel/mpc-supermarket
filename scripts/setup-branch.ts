/**
 * Create a branch with N counters, one printer per counter and one print agent.
 * Usage: npm run setup:branch -- <slug> "<Branch name>" <counters> [order-prefix]
 * Example: npm run setup:branch -- main "Main Store" 2 M
 * Prints the print-agent token ONCE - store it on the counter PC.
 */
import { createContext } from '../src/context.js';
import { randomToken, sha256 } from '../src/lib/util.js';

const [slug, name, countersArg, prefixArg] = process.argv.slice(2);
const counters = Number(countersArg);
const prefix = (prefixArg ?? 'M').toUpperCase();
if (!slug || !/^[a-z0-9-]{2,40}$/.test(slug) || !name || !(counters >= 1 && counters <= 20) || !/^[A-Z]{1,3}$/.test(prefix)) {
  console.error('Usage: npm run setup:branch -- <slug: lowercase-letters-digits> "<Branch name>" <counters 1-20> [order prefix, e.g. M]');
  process.exit(1);
}
const ctx = createContext();
const { db } = ctx;
if (db.get('SELECT 1 FROM branches WHERE slug = ?', slug)) {
  console.error(`Branch "${slug}" already exists. Change it in Admin -> Settings.`);
  process.exit(1);
}
const id = `br_${slug.replace(/-/g, '_')}`;
const token = `mpcagent_${randomToken(32)}`;
db.tx(() => {
  db.run(`INSERT INTO branches (id, slug, name_en, order_prefix, routing, store_info) VALUES (?,?,?,?,?,?)`, id, slug, name, prefix, counters > 1 ? 'least_busy' : 'default', JSON.stringify({ verified: false }));
  db.run('INSERT INTO print_agents (id, branch_id, name, token_hash) VALUES (?,?,?,?)', `agt_${slug}_1`, id, 'Counter PC', sha256(token));
  for (let n = 1; n <= counters; n++) {
    db.run('INSERT INTO printers (id, branch_id, name, paper_width_mm, agent_id) VALUES (?,?,?,?,?)', `prn_${slug}_c${n}`, id, `Counter ${n} printer`, 80, `agt_${slug}_1`);
    db.run('INSERT INTO counters (id, branch_id, number, name, printer_id) VALUES (?,?,?,?,?)', `ctr_${slug}_${n}`, id, n, `Counter ${n}`, `prn_${slug}_c${n}`);
  }
  db.run('UPDATE branches SET default_counter_id = ? WHERE id = ?', `ctr_${slug}_1`, id);
});
console.log(`Created branch "${name}" (/s/${slug}) with ${counters} counter(s).
Printer ids for the agent config: ${Array.from({ length: counters }, (_, i) => `prn_${slug}_c${i + 1}`).join(', ')}
Print agent token (shown once): ${token}`);
ctx.db.close();
