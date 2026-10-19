// Single-owner auth. Anyone may browse jobs; the tracker, alerts and settings need the
// owner password (OWNER_PASSWORD). Sessions are stateless HMAC-signed cookies.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { one, q } from './db.js';

const COOKIE = 'fa_session';
const SESSION_DAYS = 14;
const MAX_FAILS = 8;          // per IP …
const FAIL_WINDOW_MIN = 15;   // … per 15 minutes

const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (at least 32 characters).');
  return s;
};

// Hash both sides first so the comparison takes the same time whatever the lengths.
const safeEqual = (a, b) => timingSafeEqual(
  createHash('sha256').update(String(a)).digest(),
  createHash('sha256').update(String(b)).digest(),
);

// The password is part of the signed payload, so changing OWNER_PASSWORD signs out every session.
const sign = (payload) => createHmac('sha256', secret()).update(`${payload}.${process.env.OWNER_PASSWORD ?? ''}`).digest('base64url');

const readCookie = (req, name) => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return null; } }
  }
  return null;
};

export const isOwner = (req) => {
  const raw = readCookie(req, COOKIE);
  if (!raw) return false;
  const [exp, mac] = raw.split('.');
  if (!exp || !mac || !safeEqual(mac, sign(`owner.${exp}`))) return false;
  return Number(exp) > Date.now();
};

const cookieFlags = () => `Path=/; HttpOnly; SameSite=Lax${process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

// On Vercel, x-vercel-forwarded-for / x-real-ip are set by the platform and can't be spoofed by
// the client, unlike the left-most X-Forwarded-For entry.
const clientIp = (req) => String(
  (process.env.VERCEL && (req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'])) || req.socket.remoteAddress || 'unknown',
).split(',')[0].trim().slice(0, 64);

export const login = async (req, res) => {
  const ip = clientIp(req);
  const expected = process.env.OWNER_PASSWORD;
  if (!expected || expected.length < 12) return res.status(503).json({ error: 'Sign-in is not set up on the server.' });

  // Record the attempt before checking, so parallel guesses all count against the limit.
  const attempt = await one('INSERT INTO login_attempts (ip) VALUES ($1) RETURNING ctid::text AS ref', [ip]);
  const { n } = await one(`SELECT count(*)::int AS n FROM login_attempts
                           WHERE ip = $1 AND at > now() - make_interval(mins => $2)`, [ip, FAIL_WINDOW_MIN]);
  if (n > MAX_FAILS) return res.status(429).json({ error: `Too many sign-in attempts. Try again in ${FAIL_WINDOW_MIN} minutes.` });
  if (typeof req.body?.password !== 'string' || !safeEqual(req.body.password, expected)) {
    await q("DELETE FROM login_attempts WHERE at < now() - interval '1 day'");
    return res.status(401).json({ error: 'Wrong password.' });
  }
  await q('DELETE FROM login_attempts WHERE ctid::text = $1', [attempt.ref]); // a correct password is not a failure
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(`owner.${exp}`)}; Max-Age=${SESSION_DAYS * 86400}; ${cookieFlags()}`);
  res.json({ owner: true });
};

export const logout = (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags()}`);
  res.json({ owner: false });
};

export const requireOwner = (req, res, next) => {
  if (isOwner(req)) return next();
  res.status(401).json({ error: 'Sign in to use this.' });
};

/**
 * Blocks cross-site writes: browsers always send Origin on POST/PUT/DELETE, and it must be
 * this site. Together with SameSite cookies and JSON-only bodies this stops CSRF.
 */
export const sameOrigin = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin) {
    try { if (new URL(origin).host === host) return next(); } catch { /* malformed */ }
    return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  return next(); // non-browser clients (curl, cron) send no Origin and carry no cookie of ours
};

/** Scheduler calls (QStash, Vercel Cron, cron-job.org) must send Authorization: Bearer CRON_SECRET. */
export const requireCron = (req, res, next) => {
  const s = process.env.CRON_SECRET;
  const header = req.headers.authorization ?? '';
  if (s && s.length >= 32 && safeEqual(header, `Bearer ${s}`)) return next();
  res.status(401).json({ error: 'Unauthorized' });
};
