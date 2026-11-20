import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { config, assertProductionConfig } from './config.js';
import { createContext, type AppContext } from './context.js';
import { Worker } from './worker.js';
import { loadStaff } from './lib/auth.js';
import { HttpError } from './lib/util.js';
import { publicRoutes } from './routes/public.js';
import { apiRoutes, agentRoutes } from './routes/api.js';
import { staffRoutes } from './routes/staff.js';
import { adminRoutes } from './routes/admin.js';
import { layout } from './views/layout.js';
import { errorPage } from './views/shop.js';
import { langOf } from './routes/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Project root: the nearest ancestor with a public/ folder (works from src/ via tsx and from dist/). */
function findRoot(start: string) {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'public')) && fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
const root = findRoot(here);
const require = createRequire(import.meta.url);

export function createApp(ctx: AppContext, worker?: Worker) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.publicBaseUrl.startsWith('https://') ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      strictTransportSecurity: config.publicBaseUrl.startsWith('https://'),
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
  });

  // Static assets
  const publicDir = path.join(root, 'public');
  app.use(express.static(publicDir, { maxAge: '7d', index: false }));
  const fontDirs = [
    path.dirname(require.resolve('@fontsource/poppins/package.json')) + '/files',
    path.dirname(require.resolve('@fontsource/noto-sans-tamil/package.json')) + '/files',
  ];
  for (const d of fontDirs) app.use('/fonts', express.static(d, { maxAge: '30d', immutable: true }));
  app.get('/vendor/zxing.min.js', (_req, res) => res.set('Cache-Control', 'public, max-age=2592000').sendFile(path.join(path.dirname(require.resolve('@zxing/library/package.json')), 'umd/index.min.js')));

  app.use(express.json({ limit: '16mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  app.use(loadStaff(ctx.db));

  app.use('/api/agent', agentRoutes(ctx));
  app.use('/api', apiRoutes(ctx));
  app.use(staffRoutes(ctx));
  app.use(adminRoutes(ctx, worker));
  app.use(publicRoutes(ctx));

  app.use((req, _res, next) => next(new HttpError(404, 'NOT_FOUND', `Page not found: ${req.path}`)));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : err?.type === 'entity.too.large' ? 413 : err?.status && err.status < 500 ? err.status : 500;
    if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
    const message = status >= 500 && !(err instanceof HttpError) ? 'Something went wrong. Please try again.' : err.message;
    const body = { ok: false, error: message, code: err instanceof HttpError ? err.code : 'ERROR', details: err instanceof HttpError ? err.details : undefined };
    res.status(status);
    if (req.originalUrl.startsWith('/api') || (req.headers.accept ?? '').includes('application/json') || req.headers['x-requested-with'] === 'fetch') return res.json(body);
    const lang = langOf(req);
    res.send(layout({ lang, title: `${status} — MPC`, noindex: true, body: errorPage(lang, status, message) }).value);
  });
  return app;
}

async function main() {
  assertProductionConfig();
  const ctx = createContext();
  if (!ctx.orders.branches().length) {
    console.warn('No branches configured. Run `npm run seed:demo` (demo) or see docs/SETUP.md.');
  }
  const worker = new Worker(ctx);
  worker.start();
  const app = createApp(ctx, worker);
  app.listen(config.port, () => {
    console.log(`MPC Scan & Shop on ${config.publicBaseUrl} (port ${config.port})${config.demoMode ? ' — DEMO MODE' : ''}, POS adapter: ${ctx.pos.name}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
