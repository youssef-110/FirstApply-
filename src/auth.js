// Passwordless accounts. Anyone may browse jobs; signing in (via a one-time link sent by
// email) unlocks saved jobs, the application tracker and email alerts.
//
// Sessions are HMAC-signed cookies carrying the user id and the user's session_version.
// Bumping session_version (sign out everywhere, account deletion) revokes every cookie.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { one, q } from './db.js';

const COOKIE = 'fa_session';
const SESSION_DAYS = 30;
const LINK_MINUTES = 15;

const secret = () => {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (at least 32 characters).');
  return s;
};

// Hash both sides first so the comparison takes the same time whatever the lengths.
export const safeEqual = (a, b) => timingSafeEqual(
  createHash('sha256').update(String(a)).digest(),
  createHash('sha256').update(String(b)).digest(),
);

export const hmac = (payload) => createHmac('sha256', secret()).update(payload).digest('base64url');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export const normalizeEmail = (raw) => {
  const email = String(raw ?? '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/.test(email) ? email : null;
};

const readCookie = (req, name) => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return null; } }
  }
  return null;
};

const cookieFlags = () => `Path=/; HttpOnly; SameSite=Lax${process.env.VERCEL || process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

// On Vercel, x-vercel-forwarded-for / x-real-ip are set by the platform and can't be spoofed by
// the client, unlike the left-most X-Forwarded-For entry.
export const clientIp = (req) => String(
  (process.env.VERCEL && (req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'])) || req.socket.remoteAddress || 'unknown',
).split(',')[0].trim().slice(0, 64);

/**
 * Counts an event against a limit. Returns false once `max` events happened within
 * `windowMinutes`. The event is recorded first, so parallel requests all count.
 */
export const rateLimit = async (key, max, windowMinutes) => {
  await q('INSERT INTO rate_events (key) VALUES ($1)', [key]);
  const { n } = await one(`SELECT count(*)::int AS n FROM rate_events
                           WHERE key = $1 AND at > now() - make_interval(mins => $2)`, [key, windowMinutes]);
  if (Math.random() < 0.05) await q("DELETE FROM rate_events WHERE at < now() - interval '2 days'");
  return n <= max;
};

/**
 * Takes one unit from a shared budget only if it isn't used up. Unlike rateLimit, refused
 * requests are not recorded, so a flood can't keep a budget exhausted by hammering it.
 */
export const takeQuota = async (key, max, windowMinutes) => {
  const row = await one(`INSERT INTO rate_events (key)
    SELECT $1 WHERE (SELECT count(*) FROM rate_events
                     WHERE key = $1 AND at > now() - make_interval(mins => $3)) < $2
    RETURNING 1 AS ok`, [key, max, windowMinutes]);
  return !!row;
};

/** Returns the signed-in user ({ id, email, ... }) or null. Cached per request. */
export const getUser = async (req) => {
  if (req.user !== undefined) return req.user;
  req.user = null;
  const raw = readCookie(req, COOKIE);
  const [uid, ver, exp, mac] = raw?.split('.') ?? [];
  if (!uid || !ver || !exp || !mac) return null;
  if (!safeEqual(mac, hmac(`session.${uid}.${ver}.${exp}`)) || Number(exp) < Date.now()) return null;
  const user = await one('SELECT * FROM users WHERE id = $1 AND session_version = $2', [Number(uid), Number(ver)]);
  req.user = user ?? null;
  return req.user;
};

export const isAdmin = (user) => !!user && !!process.env.ADMIN_EMAIL && user.email === normalizeEmail(process.env.ADMIN_EMAIL);

export const setSession = (res, user) => {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const value = `${user.id}.${user.session_version}.${exp}`;
  res.setHeader('Set-Cookie', `${COOKIE}=${value}.${hmac(`session.${value}`)}; Max-Age=${SESSION_DAYS * 86400}; ${cookieFlags()}`);
};

export const clearSession = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags()}`);

/** Creates a one-time sign-in token for an email; only its hash is stored. */
export const createLoginToken = async (rawEmail) => {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new Error('Invalid email address.');
  const token = randomBytes(32).toString('base64url');
  await q(`INSERT INTO login_tokens (token_hash, email, expires_at)
           VALUES ($1, $2, now() + make_interval(mins => $3))`, [sha256(token), email, LINK_MINUTES]);
  return token;
};

/** Consumes a token (single use). Returns the email it was issued for, or null. */
export const consumeLoginToken = async (token) => {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = await one(`UPDATE login_tokens SET used_at = now()
    WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING email`, [sha256(token)]);
  if (Math.random() < 0.1) await q("DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day'");
  return row?.email ?? null;
};

export const requireUser = async (req, res, next) => {
  try {
    if (await getUser(req)) return next();
    res.status(401).json({ error: 'Sign in to use this.' });
  } catch (err) { next(err); }
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

// Per-user unsubscribe links work without signing in, so they carry their own signature.
export const unsubscribeToken = (userId) => hmac(`unsubscribe.${userId}`);
export const checkUnsubscribeToken = (userId, token) => typeof token === 'string' && safeEqual(token, unsubscribeToken(userId));
