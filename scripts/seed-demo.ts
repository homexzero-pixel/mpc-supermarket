import fs from 'node:fs';
import { createContext } from '../src/context.js';
import { config } from '../src/config.js';
import { seedDemo, DEMO_PASSWORD } from '../src/demo/seed.js';

if (!config.demoMode) {
  console.error('Refusing to seed demo data: DEMO_MODE is not true. Demo products must never mix with production data.');
  process.exit(1);
}
const ctx = createContext();
const tokenFile = 'data/demo-agent.token';
const existing = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : undefined;
const r = await seedDemo(ctx, { agentToken: existing });
fs.writeFileSync(tokenFile, r.agentToken);
console.log(`Demo data ready in ${config.databasePath} (POS simulator: ${config.posSimDatabasePath}).
Staff logins (password "${DEMO_PASSWORD}"): ${r.staff.map((s) => `${s.username} (${s.role})`).join(', ')}
Print agent token saved to ${tokenFile}`);
ctx.db.close();
