import type { Request, Response, NextFunction } from 'express';
import { HttpError } from './util.js';

/**
 * Fixed-window in-memory limiter (per process). For multi-instance deployments
 * add a shared limiter at the reverse proxy as well.
 */
export function rateLimit(opts: { windowMs: number; max: number; key: (req: Request) => string; message?: string }) {
  const hits = new Map<string, { n: number; reset: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, opts.windowMs).unref();
  return (req: Request, _res: Response, next: NextFunction) => {
    const k = opts.key(req);
    const now = Date.now();
    const h = hits.get(k);
    if (!h || h.reset < now) hits.set(k, { n: 1, reset: now + opts.windowMs });
    else if (++h.n > opts.max) return next(new HttpError(429, 'RATE_LIMITED', opts.message ?? 'Too many requests - please wait a moment'));
    next();
  };
}
