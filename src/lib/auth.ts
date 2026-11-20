import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Db, Row } from '../db/index.js';
import { HttpError, addSeconds, nowIso, randomToken, safeEqual, sha256 } from './util.js';
import { config } from '../config.js';

export type Role = 'owner' | 'manager' | 'cashier';
const RANK: Record<Role, number> = { cashier: 1, manager: 2, owner: 3 };
const COOKIE = 'mpc_staff';

export function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(pw: string, stored: string) {
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(h, 'base64'));
}

export function createSession(db: Db, res: Response, staff: Row) {
  const token = randomToken(32);
  const csrf = randomToken(18);
  db.run('INSERT INTO sessions (id_hash, staff_id, csrf, expires_at) VALUES (?,?,?,?)', sha256(token), staff.id, csrf, addSeconds(nowIso(), 12 * 3600));
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.publicBaseUrl.startsWith('https://'), maxAge: 12 * 3600 * 1000, path: '/' });
  return token;
}
export function destroySession(db: Db, req: Request, res: Response) {
  const t = req.cookies?.[COOKIE];
  if (t) db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(t));
  res.clearCookie(COOKIE, { path: '/' });
}

export type StaffUser = Row & { branchScope: string[] | '*'; csrf: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      staff?: StaffUser;
    }
  }
}

export function loadStaff(db: Db) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const t = req.cookies?.[COOKIE];
    if (t) {
      const s = db.get<Row>(
        `SELECT st.*, se.csrf FROM sessions se JOIN staff st ON st.id = se.staff_id WHERE se.id_hash = ? AND se.expires_at > ? AND st.active = 1`,
        sha256(t), nowIso(),
      );
      if (s) req.staff = { ...s, branchScope: s.branch_ids === '*' ? '*' : JSON.parse(s.branch_ids) } as StaffUser;
    }
    next();
  };
}

export function requireRole(min: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.staff) {
      if (req.method === 'GET' && !req.originalUrl.startsWith('/api')) return res.redirect(`/staff/login?next=${encodeURIComponent(req.originalUrl)}`);
      return next(new HttpError(401, 'LOGIN', 'Please sign in'));
    }
    if (RANK[req.staff.role as Role] < RANK[min]) return next(new HttpError(403, 'FORBIDDEN', 'Your role cannot do this'));
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const token = (req.headers['x-csrf-token'] as string) || req.body?._csrf;
      if (!token || !safeEqual(String(token), req.staff.csrf)) return next(new HttpError(403, 'CSRF', 'Session check failed - reload the page'));
    }
    next();
  };
}

export function canAccessBranch(staff: StaffUser | undefined, branchId: string) {
  return !!staff && (staff.branchScope === '*' || staff.branchScope.includes(branchId));
}
export function assertBranch(staff: StaffUser | undefined, branchId: string) {
  if (!canAccessBranch(staff, branchId)) throw new HttpError(403, 'BRANCH', 'You are not assigned to this branch');
}
export const hasRole = (staff: Row | undefined, min: Role) => !!staff && RANK[staff.role as Role] >= RANK[min];
