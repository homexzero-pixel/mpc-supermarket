/**
 * One command for a local DEMO: seeds sample data if needed, starts the web
 * server + background worker, and runs the store print agent with a simulated
 * printer that writes slips to data/sim-prints/.
 */
import fs from 'node:fs';
import { config } from '../src/config.js';
import { createContext } from '../src/context.js';
import { seedDemo, DEMO_PASSWORD } from '../src/demo/seed.js';
import { Worker } from '../src/worker.js';
import { createApp } from '../src/server.js';
import { runAgent } from '../agent/print-agent.js';

if (!config.demoMode) {
  console.error('npm run demo only runs with DEMO_MODE=true.');
  process.exit(1);
}
const ctx = createContext();
const tokenFile = 'data/demo-agent.token';
const existing = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : undefined;
const seed = await seedDemo(ctx, { agentToken: existing });
fs.writeFileSync(tokenFile, seed.agentToken);
const worker = new Worker(ctx);
worker.start();
createApp(ctx, worker).listen(config.port, () => {
  console.log(`
  MPC Scan & Shop — DEMO MODE
  Shop (phone):     ${config.publicBaseUrl}/s/main      <- what the entrance QR opens
  Public site:      ${config.publicBaseUrl}/
  Cashier screen:   ${config.publicBaseUrl}/staff       (cashier1 / ${DEMO_PASSWORD})
  Owner/manager:    owner, manager                       (same password)
  Printed slips:    data/sim-prints/*.txt
`);
  void runAgent({ server: `http://127.0.0.1:${config.port}`, token: seed.agentToken, printers: {}, defaultTarget: 'dir:data/sim-prints', pollMs: 1500, stateFile: 'data/agent-pending-reports.json' });
});
