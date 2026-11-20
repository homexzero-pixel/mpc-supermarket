import path from 'node:path';
import fs from 'node:fs';

/** Load KEY=VALUE pairs from .env if present (no dependency needed). */
function loadDotEnv() {
  const p = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const env = (k: string, d?: string) => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', '3000')),
  publicBaseUrl: (env('PUBLIC_BASE_URL', 'http://localhost:3000') as string).replace(/\/$/, ''),
  databasePath: env('DATABASE_PATH', 'data/mpc.db') as string,
  /** demo = clearly labelled demo mode with the POS simulator. */
  demoMode: env('DEMO_MODE', 'true') === 'true',
  posAdapter: env('POS_ADAPTER', 'simulator') as 'simulator' | 'http',
  posBaseUrl: env('POS_BASE_URL', ''),
  posApiKey: env('POS_API_KEY', ''),
  posSimDatabasePath: env('POS_SIM_DATABASE_PATH', 'data/pos-sim.db') as string,
  sessionSecret: env('SESSION_SECRET', 'dev-only-change-me') as string,
  timezone: env('STORE_TIMEZONE', 'Asia/Kolkata') as string,
  workerIntervalMs: Number(env('WORKER_INTERVAL_MS', '1500')),
  printLeaseSeconds: Number(env('PRINT_LEASE_SECONDS', '30')),
  catalogueSyncMinutes: Number(env('CATALOGUE_SYNC_MINUTES', '15')),
  trustProxy: env('TRUST_PROXY', 'false') === 'true',
  allowIndexing: env('ALLOW_INDEXING', 'false') === 'true',
  /** basket submissions allowed per IP per 10 minutes (a whole family on shop Wi-Fi shares one IP) */
  checkoutRateLimit: Number(env('CHECKOUT_RATE_LIMIT', '30')),
};

export function assertProductionConfig() {
  if (config.demoMode) return;
  const problems: string[] = [];
  if (config.sessionSecret === 'dev-only-change-me' || config.sessionSecret.length < 32)
    problems.push('SESSION_SECRET must be a random string of at least 32 characters');
  if (config.posAdapter === 'http' && (!config.posBaseUrl || !config.posApiKey))
    problems.push('POS_BASE_URL and POS_API_KEY are required when POS_ADAPTER=http');
  if (!config.publicBaseUrl.startsWith('https://')) problems.push('PUBLIC_BASE_URL should be https:// in production');
  if (problems.length) throw new Error('Configuration problems:\n - ' + problems.join('\n - '));
}
