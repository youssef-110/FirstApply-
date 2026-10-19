import express from 'express';
import { waitUntil } from '@vercel/functions';
import { migrate, one, q } from './db.js';
import { seed } from './seed.js';
import { buildWhere, describeFilters, parseFilters } from './filters.js';
import { alertCounts, appUrl, describeAlert, previewEmailHtml, sendSignInEmail, sendTestEmail } from './alerts.js';
import { mailProvider } from './mailer.js';
import { syncSource, syncStatus, tick } from './sync.js';
import {
  checkUnsubscribeToken, clearSession, clientIp, consumeLoginToken, createLoginToken, getUser, isAdmin,
  normalizeEmail, rateLimit, requireCron, requireUser, sameOrigin, setSession, takeQuota,
} from './auth.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use('/api', sameOrigin);

// Express 4 does not catch rejected promises; route them to the error handler.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const STATUSES = new Set(['saved', 'applied', 'interviewing', 'offer', 'rejected', 'hidden']);
const TRACKED = ['applied', 'interviewing', 'offer', 'rejected'];
const MAX_ALERTS = 20;
const SORTS = {
  newest: 'j.posted_at DESC NULLS LAST',
  discovered: 'j.first_seen_at DESC, j.posted_at DESC NULLS LAST',
  salary: 'j.salary_min DESC NULLS LAST, j.posted_at DESC NULLS LAST',
};
const PUBLIC_COLUMNS = `j.id, j.source, j.title, j.company, j.company_logo, j.city, j.state, j.types, j.field, j.sub_field,
  j.working_mode, j.german, j.english, j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.skills,
  j.url, j.apply_url, j.posted_at, j.first_seen_at, j.active`;

const tooMany = (res, minutes) => res.status(429).json({ error: `Too many requests. Try again in ${minutes} minutes.` });

// ---------- accounts: sign in by email link ----------
app.get('/api/me', ah(async (req, res) => {
  const user = await getUser(req);
  res.json({ user: user && { email: user.email, emailsPaused: user.emails_paused }, admin: isAdmin(user) });
}));

app.post('/api/auth/request', ah(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Enter a valid email address, like name@example.com.' });
  if (req.body?.acceptTerms !== true) return res.status(400).json({ error: 'Please accept the terms and privacy policy to continue.' });
  if (!mailProvider()) return res.status(503).json({ error: 'Sign-in emails are not set up on this server yet.' });
  // Visible limits are keyed on the requester (IP, or IP + address), so an attacker can only
  // ever block their own requests, never lock the real owner out of their account.
  const ip = clientIp(req);
  if (!(await rateLimit(`signin-ip:${ip}`, 10, 60))) return tooMany(res, 60);
  if (!(await rateLimit(`signin-ip-email:${ip}:${email}`, 3, 15))) return tooMany(res, 15);

  // Silent limits: past these, no email is sent but the answer is identical, so they reveal
  // nothing about whether an address has an account. They only count emails actually sent
  // (takeQuota), so hammering a limit doesn't keep it tripped.
  //  - per address, per hour: caps how fast anyone can fill one inbox, while any lockout of
  //    the owner lasts at most an hour
  //  - per pool, per day: keeps the total under the email provider's quota (a hard limit we
  //    can't exceed without breaking email for everyone). New and existing addresses have
  //    separate pools, so fake sign-ups can't use up existing users' budget, and an existing
  //    account's first 2 sign-ins a day may use the whole pool while repeat requests stop
  //    at a lower soft cap.
  const gmail = mailProvider() === 'gmail';
  const known = await one('SELECT 1 FROM users WHERE email = $1', [email]);
  let allowed = await takeQuota(`signin-email-hour:${email}`, 6, 60);
  if (allowed && known) {
    const firstToday = await takeQuota(`signin-known-reserved:${email}`, 2, 60 * 24);
    allowed = await takeQuota('signin-known', firstToday ? (gmail ? 200 : 40) : (gmail ? 100 : 20), 60 * 24);
  } else if (allowed) {
    allowed = await takeQuota('signin-new', Number(process.env.SIGNUP_DAILY_LIMIT || (gmail ? 150 : 30)), 60 * 24);
  }

  // Answer first, send afterwards: every path takes the same time, so response timing can't
  // reveal which limit applied or whether the address has an account.
  res.json({ sent: true });
  if (!allowed) return console.warn(`[auth] sign-in email skipped (${known ? "existing" : "new"} address, limit reached)`);
  const send = (async () => {
    const token = await createLoginToken(email);
    // The token sits in the URL fragment, so it never reaches server or proxy logs.
    await sendSignInEmail(email, `${appUrl()}/signin.html#t=${token}`);
  })().catch((err) => console.error('[auth] sign-in email failed:', err.message));
  waitUntil(send); // keeps the serverless function alive until the email is sent
}));

app.post('/api/auth/verify', ah(async (req, res) => {
  if (!(await rateLimit(`verify-ip:${clientIp(req)}`, 30, 15))) return tooMany(res, 15);
  const email = await consumeLoginToken(req.body?.token);
  if (!email) return res.status(400).json({ error: 'This sign-in link has expired or was already used. Request a new one.' });
  const user = await one(`
    INSERT INTO users (email, terms_accepted_at, last_login_at) VALUES ($1, now(), now())
    ON CONFLICT (email) DO UPDATE SET last_login_at = now(),
      terms_accepted_at = COALESCE(users.terms_accepted_at, now())
    RETURNING *`, [email]);
  setSession(res, user);
  res.json({ email: user.email });
}));

app.post('/api/auth/logout', (_req, res) => { clearSession(res); res.json({ ok: true }); });

// One-click unsubscribe from alert emails (link in every email; RFC 8058 POST from mail apps).
const unsubscribe = ah(async (req, res) => {
  const userId = Number(req.query.u);
  if (!Number.isInteger(userId) || !checkUnsubscribeToken(userId, req.query.t)) {
    return res.status(400).type('html').send(page('Link not valid', 'This unsubscribe link is not valid. Sign in to Firstapply to manage your alerts.'));
  }
  await q('UPDATE users SET emails_paused = true WHERE id = $1', [userId]);
  res.type('html').send(page('You are unsubscribed', 'You won\'t get any more job alert emails. Your alerts are kept, so you can turn emails back on from the Alerts page at any time.'));
});
app.get('/api/unsubscribe', unsubscribe);
app.post('/api/unsubscribe', unsubscribe);

const page = (title, text) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Firstapply</title><link rel="stylesheet" href="/legal/legal.css"></head>
  <body><main class="legal"><a class="brand" href="/"><img src="/logo.svg" width="28" height="28" alt="">Firstapply</a>
  <h1>${title}</h1><p>${text}</p><p><a href="/">Go to Firstapply</a></p></main></body></html>`;

// ---------- jobs (public; personal status only for the signed-in user) ----------
app.get('/api/jobs', ah(async (req, res) => {
  const user = await getUser(req);
  const f = parseFilters(req.query);
  const params = [];
  const { where } = buildWhere(f, params);
  let join = '';
  let view = '';
  if (user) {
    params.push(user.id);
    join = `LEFT JOIN user_job_status s ON s.job_id = j.id AND s.user_id = $${params.length}`;
    // Applied/hidden jobs live in the tracker; the feed keeps jobs still to act on.
    if (req.query.include !== 'all') view = " AND (s.status IS NULL OR s.status = 'saved')";
  }
  const sort = Object.hasOwn(SORTS, req.query.sort) ? SORTS[req.query.sort] : SORTS.newest;
  const size = Math.min(50, Math.max(1, Math.floor(Number(req.query.size)) || 30));
  const pageNo = Math.min(200, Math.max(1, Math.floor(Number(req.query.page)) || 1));

  const { n: total } = await one(`SELECT count(*)::int AS n FROM jobs j ${join} WHERE ${where}${view}`, params);
  const items = await q(`SELECT ${PUBLIC_COLUMNS}${user ? ', s.status' : ', NULL AS status'} FROM jobs j ${join}
    WHERE ${where}${view} ORDER BY ${sort} LIMIT ${size} OFFSET ${(pageNo - 1) * size}`, params);
  res.json({ items, total, page: pageNo, size, summary: describeFilters(f) });
}));

app.get('/api/jobs/:id', ah(async (req, res) => {
  const user = await getUser(req);
  const row = user
    ? await one(`SELECT ${PUBLIC_COLUMNS}, s.status, s.notes, s.applied_at FROM jobs j
        LEFT JOIN user_job_status s ON s.job_id = j.id AND s.user_id = $2 WHERE j.id = $1`, [req.params.id, user.id])
    : await one(`SELECT ${PUBLIC_COLUMNS} FROM jobs j WHERE j.id = $1`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'This job is no longer listed.' });
  res.json({ ...row, status: row.status ?? null, notes: row.notes ?? '', applied_at: row.applied_at ?? null });
}));

app.get('/api/facets', ah(async (_req, res) => {
  const base = 'FROM jobs WHERE active AND dup_of IS NULL';
  const [cities, fields, subFields, total] = await Promise.all([
    q(`SELECT city AS value, count(*)::int AS n ${base} AND city IS NOT NULL GROUP BY city ORDER BY n DESC LIMIT 400`),
    q(`SELECT field AS value, count(*)::int AS n ${base} GROUP BY field ORDER BY n DESC`),
    q(`SELECT sub_field AS value, field, count(*)::int AS n ${base} AND sub_field IS NOT NULL GROUP BY sub_field, field ORDER BY n DESC`),
    one(`SELECT count(*)::int AS n ${base}`),
  ]);
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  res.json({ cities, fields, subFields, total: total.n });
}));

app.get('/api/status', ah(async (_req, res) => {
  const { syncs } = await syncStatus();
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120'); // no personal data
  res.json({ syncs: Object.fromEntries(Object.entries(syncs).map(([k, s]) => [k, { label: s.label, at: s.at ?? null, new: s.new ?? 0 }])) });
}));

// ---------- scheduler ----------
const runTick = ah(async (req, res) => res.json(await tick({ force: req.query.force === '1' })));
app.get('/api/cron/tick', requireCron, runTick);
app.post('/api/cron/tick', requireCron, runTick);

// Creates (or replaces) the QStash schedule that calls /api/cron/tick every 5 minutes.
// Runs on the server because QSTASH_TOKEN is a sensitive env var that can't be read locally.
app.post('/api/cron/schedule', requireCron, ah(async (_req, res) => {
  const token = process.env.QSTASH_TOKEN;
  if (!token) return res.status(503).json({ error: 'QSTASH_TOKEN is not set on this deployment.' });
  if (!process.env.APP_URL) return res.status(503).json({ error: 'APP_URL is not set.' });
  const base = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/$/, '');
  const target = `${appUrl()}/api/cron/tick`;
  const r = await fetch(`${base}/v2/schedules/${target}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Upstash-Cron': '*/5 * * * *',
      'Upstash-Schedule-Id': 'firstapply-tick', // same id = update in place, never a duplicate
      'Upstash-Retries': '0',                   // the next tick is 5 minutes away anyway
      'Upstash-Timeout': '280s',
      'Upstash-Forward-Authorization': `Bearer ${process.env.CRON_SECRET}`,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ error: `QStash refused the schedule (${r.status}): ${body.error ?? 'unknown error'}` });
  res.json({ scheduleId: body.scheduleId, cron: '*/5 * * * *', target });
}));

// Idempotent database setup and migration, run on the server where DATABASE_URL lives.
app.post('/api/cron/setup', requireCron, ah(async (req, res) => {
  await migrate();
  await seed();
  const results = req.query.import === '0' ? [] : [await syncSource('wsj', { full: true }), await syncSource('ba')];
  res.json({ migrated: true, results });
}));

// ---------- signed-in users ----------
app.use('/api', requireUser);

app.put('/api/jobs/:id/status', ah(async (req, res) => {
  const { status, notes } = req.body ?? {};
  const job = await one('SELECT id FROM jobs WHERE id = $1', [req.params.id]);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (status === null || status === '') {
    await q('DELETE FROM user_job_status WHERE user_id = $1 AND job_id = $2', [req.user.id, job.id]);
    return res.json({ status: null });
  }
  if (!STATUSES.has(status)) return res.status(400).json({ error: 'Unknown status.' });
  const note = typeof notes === 'string' ? notes.slice(0, 2000) : null;
  const row = await one(`
    INSERT INTO user_job_status (user_id, job_id, status, notes, applied_at, updated_at)
    VALUES ($1, $2, $3, COALESCE($4, ''), CASE WHEN $3 = ANY($5::text[]) THEN now() END, now())
    ON CONFLICT (user_id, job_id) DO UPDATE SET status = excluded.status,
      notes = COALESCE($4, user_job_status.notes),
      applied_at = COALESCE(user_job_status.applied_at, excluded.applied_at),
      updated_at = now()
    RETURNING status, applied_at`, [req.user.id, job.id, status, note, TRACKED]);
  res.json(row);
}));

app.get('/api/tracker', ah(async (req, res) => {
  res.json(await q(`SELECT ${PUBLIC_COLUMNS}, s.status, s.notes, s.applied_at, s.updated_at AS status_updated_at
    FROM user_job_status s JOIN jobs j ON j.id = s.job_id WHERE s.user_id = $1 AND s.status <> 'hidden'
    ORDER BY COALESCE(s.applied_at, s.updated_at) DESC LIMIT 1000`, [req.user.id]));
}));

const alertOut = async (a) => ({
  id: a.id, name: a.name, filters: a.filters, frequency: a.frequency, enabled: a.enabled, created_at: a.created_at,
  summary: describeAlert(a.filters), ...(await alertCounts(a)),
});
const ownAlert = (req) => one('SELECT * FROM alerts WHERE id = $1 AND user_id = $2', [Number(req.params.id) || 0, req.user.id]);

app.get('/api/alerts', ah(async (req, res) => {
  const alerts = await q('SELECT * FROM alerts WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(await Promise.all(alerts.map(alertOut)));
}));

app.post('/api/alerts', ah(async (req, res) => {
  const { n } = await one('SELECT count(*)::int AS n FROM alerts WHERE user_id = $1', [req.user.id]);
  if (n >= MAX_ALERTS) return res.status(400).json({ error: `You have ${MAX_ALERTS} alerts. Delete one before adding another.` });
  const filters = parseFilters(req.body?.filters ?? {});
  const name = String(req.body?.name || describeFilters(filters)).trim().slice(0, 120) || 'New jobs';
  const frequency = req.body?.frequency === 'daily' ? 'daily' : 'instant';
  const alert = await one('INSERT INTO alerts (user_id, name, filters, frequency) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.user.id, name, JSON.stringify(filters), frequency]);
  res.status(201).json(await alertOut(alert));
}));

app.put('/api/alerts/:id', ah(async (req, res) => {
  const a = await ownAlert(req);
  if (!a) return res.status(404).json({ error: 'Alert not found.' });
  const b = req.body ?? {};
  const updated = await one('UPDATE alerts SET name = $1, frequency = $2, enabled = $3, filters = $4 WHERE id = $5 RETURNING *', [
    typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 120) : a.name,
    b.frequency === 'daily' || b.frequency === 'instant' ? b.frequency : a.frequency,
    typeof b.enabled === 'boolean' ? b.enabled : a.enabled,
    JSON.stringify(b.filters ? parseFilters(b.filters) : a.filters),
    a.id]);
  res.json(await alertOut(updated));
}));

app.delete('/api/alerts/:id', ah(async (req, res) => {
  await q('DELETE FROM alerts WHERE id = $1 AND user_id = $2', [Number(req.params.id) || 0, req.user.id]);
  res.status(204).end();
}));

// ---------- account ----------
app.get('/api/account', ah(async (req, res) => {
  const u = req.user;
  const out = {
    email: u.email,
    createdAt: u.created_at,
    emailsPaused: u.emails_paused,
    lastEmailAt: u.last_email_at,
    lastEmailError: u.last_email_error,
    mailReady: !!mailProvider(),
    pollMinutes: 5,
    admin: isAdmin(u),
  };
  if (out.admin) Object.assign(out, await syncStatus());
  res.json(out);
}));

app.put('/api/account', ah(async (req, res) => {
  if (typeof req.body?.emailsPaused !== 'boolean') return res.status(400).json({ error: 'Nothing to change.' });
  await q('UPDATE users SET emails_paused = $2 WHERE id = $1', [req.user.id, req.body.emailsPaused]);
  res.json({ emailsPaused: req.body.emailsPaused });
}));

// GDPR art. 15/20: everything stored about the user, as a JSON download.
app.get('/api/account/export', ah(async (req, res) => {
  const u = req.user;
  const data = {
    exportedAt: new Date().toISOString(),
    account: { email: u.email, createdAt: u.created_at, termsAcceptedAt: u.terms_accepted_at, lastLoginAt: u.last_login_at,
      emailsPaused: u.emails_paused, lastEmailAt: u.last_email_at },
    alerts: await q('SELECT name, filters, frequency, enabled, created_at FROM alerts WHERE user_id = $1', [u.id]),
    savedAndApplied: await q(`SELECT j.title, j.company, j.city, j.url, s.status, s.notes, s.applied_at, s.updated_at
      FROM user_job_status s JOIN jobs j ON j.id = s.job_id WHERE s.user_id = $1`, [u.id]),
    emailedJobs: await q(`SELECT j.title, j.company, d.sent_at FROM deliveries d JOIN alerts a ON a.id = d.alert_id
      JOIN jobs j ON j.id = d.job_id WHERE a.user_id = $1 AND d.sent_at IS NOT NULL ORDER BY d.sent_at DESC`, [u.id]),
  };
  res.setHeader('Content-Disposition', 'attachment; filename="firstapply-data.json"');
  res.json(data);
}));

// GDPR art. 17: deletes the account and everything linked to it.
app.delete('/api/account', ah(async (req, res) => {
  await q('DELETE FROM users WHERE id = $1', [req.user.id]); // cascades to alerts, deliveries, tracker
  await q('DELETE FROM login_tokens WHERE email = $1', [req.user.email]);
  clearSession(res);
  res.json({ deleted: true });
}));

app.post('/api/account/logout-everywhere', ah(async (req, res) => {
  await q('UPDATE users SET session_version = session_version + 1 WHERE id = $1', [req.user.id]);
  clearSession(res);
  res.json({ ok: true });
}));

app.post('/api/email/test', ah(async (req, res) => {
  if (!(await rateLimit(`test-email:${req.user.id}`, 3, 60))) return tooMany(res, 60);
  try { res.json(await sendTestEmail(req.user)); } catch (err) { res.status(400).json({ error: err.message }); }
}));

app.get('/api/email/preview', ah(async (req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src https:");
  res.type('html').send(await previewEmailHtml(req.user.id));
}));

// Manual source sync: admin only, so visitors can't hammer the job sources.
app.post('/api/sync', ah(async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only the site admin can do this.' });
  res.json(await syncSource('wsj'));
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'The request could not be read.' });
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again in a minute.' });
});
