import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Lang } from '../lib/i18n.js';
import { config } from '../config.js';

export const asyncH =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

export function langOf(req: Request): Lang {
  const c = req.cookies?.lang;
  if (c === 'ta' || c === 'en') return c;
  return /^ta\b/i.test(req.headers['accept-language'] ?? '') ? 'ta' : 'en';
}

export const IN_STORE_COOKIE = 'mpc_instore';
export function inStoreBranch(req: Request): string | undefined {
  const v = req.cookies?.[IN_STORE_COOKIE];
  return typeof v === 'string' && /^[a-z0-9-]{1,60}$/.test(v) ? v : undefined;
}

export function clientIp(req: Request) {
  return (config.trustProxy ? req.ip : req.socket.remoteAddress) ?? 'unknown';
}

/** Forms get a redirect (with a flash message); fetch() callers get JSON. */
export function wantsJson(req: Request) {
  return req.headers['x-requested-with'] === 'fetch' || (req.headers.accept ?? '').includes('application/json') || req.is('application/json') === 'application/json';
}
export function done(req: Request, res: Response, redirect: string, data: Record<string, unknown> = {}, ok?: string) {
  if (wantsJson(req)) return res.json({ ok: true, ...data });
  const sep = redirect.includes('?') ? '&' : '?';
  return res.redirect(303, ok ? `${redirect}${sep}ok=${encodeURIComponent(ok)}` : redirect);
}
export function flash(req: Request) {
  const err = typeof req.query.err === 'string' ? req.query.err.slice(0, 300) : undefined;
  const ok = typeof req.query.ok === 'string' ? req.query.ok.slice(0, 300) : undefined;
  return { err, ok };
}
export function noStore(res: Response) {
  res.setHeader('Cache-Control', 'no-store');
}
