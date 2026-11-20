import crypto from 'node:crypto';
import { config } from '../config.js';

export const nowIso = () => new Date().toISOString();
export const addSeconds = (iso: string, s: number) => new Date(Date.parse(iso) + s * 1000).toISOString();

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}
export function newId(prefix: string) {
  // time-ordered, unguessable enough for internal ids (not used as access tokens)
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
}
export function sha256(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
export function hmac(s: string) {
  return crypto.createHmac('sha256', config.sessionSecret).update(s).digest('hex');
}
export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** YYYY-MM-DD for the store's timezone. */
export function businessDate(d = new Date(), tz = config.timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function storeTime(iso: string, tz = config.timezone) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(iso));
}
export function storeClock(iso: string, tz = config.timezone) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(iso));
}
export function minutesSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
}
export function slugify(s: string) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
