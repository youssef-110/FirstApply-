import express from 'express';
import { getSetting, migrate, one, q, setSetting } from './db.js';
import { seed } from './seed.js';
import { buildWhere, describeFilters, parseFilters } from './filters.js';
import { alertCounts, describeAlert, previewEmailHtml, sendTestEmail } from './alerts.js';
import { mailProvider } from './mailer.js';
import { syncSource, syncStatus, tick } from './sync.js';
import { isOwner, login, logout, requireCron, requireOwner, sameOrigin } from './auth.js';

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
const SORTS = {
  newest: 'j.posted_at DESC NULLS LAST',
  discovered: 'j.first_seen_at DESC, j.posted_at DESC NULLS LAST',
  salary: 'j.salary_min DESC NULLS LAST, j.posted_at DESC NULLS LAST',
};
const PUBLIC_COLUMNS = `j.id, j.source, j.title, j.company, j.company_logo, j.city, j.state, j.types, j.field, j.sub_field,
  j.working_mode, j.german, j.english, j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.skills,
  j.url, j.apply_url, j.posted_at, j.first_seen_at, j.active`;

// ---------- session ----------
app.get('/api/me', (req, res) => res.json({ owner: isOwner(req) }));
app.post('/api/login', ah(login));
app.post('/api/logout', logout);

// ---------- jobs (public; personal status only for the owner) ----------
app.get('/api/jobs', ah(async (req, res) => {
  const owner = isOwner(req);
  const f = parseFilters(req.query);
  const params = [];
  const { where } = buildWhere(f, params);
  // Applied/hidden jobs live in the tracker; the feed keeps jobs still to act on.
  const join = owner ? 'LEFT JOIN job_status s ON s.job_id = j.id' : '';
  const view = owner && req.query.include !== 'all' ? " AND (s.status IS NULL OR s.status = 'saved')" : '';
  const sort = Object.hasOwn(SORTS, req.query.sort) ? SORTS[req.query.sort] : SORTS.newest;
  const size = Math.min(50, Math.max(1, Math.floor(Number(req.query.size)) || 30));
  const page = Math.min(200, Math.max(1, Math.floor(Number(req.query.page)) || 1));

  const { n: total } = await one(`SELECT count(*)::int AS n FROM jobs j ${join} WHERE ${where}${view}`, params);
  const items = await q(`SELECT ${PUBLIC_COLUMNS}${owner ? ', s.status' : ', NULL AS status'} FROM jobs j ${join}
    WHERE ${where}${view} ORDER BY ${sort} LIMIT ${size} OFFSET ${(page - 1) * size}`, params);
  res.json({ items, total, page, size, summary: describeFilters(f) });
}));

app.get('/api/jobs/:id', ah(async (req, res) => {
  const owner = isOwner(req);
  const row = await one(`SELECT ${PUBLIC_COLUMNS}${owner ? ', s.status, s.notes, s.applied_at' : ''}
    FROM jobs j ${owner ? 'LEFT JOIN job_status s ON s.job_id = j.id' : ''} WHERE j.id = $1`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'This job is no longer listed.' });
  res.json({ status: null, notes: '', applied_at: null, ...row });
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
// Creates (or replaces) the QStash schedule that calls /api/cron/tick every 5 minutes.
// Runs on the server because QSTASH_TOKEN is a sensitive env var that can't be read locally.
app.post('/api/cron/schedule', requireCron, ah(async (_req, res) => {
  const token = process.env.QSTASH_TOKEN;
  if (!token) return res.status(503).json({ error: 'QSTASH_TOKEN is not set on this deployment.' });
  if (!process.env.APP_URL) return res.status(503).json({ error: 'APP_URL is not set.' });
  const base = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/$/, '');
  const target = `${process.env.APP_URL.replace(/\/$/, '')}/api/cron/tick`;
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

// One-time (idempotent) database setup on the server, where DATABASE_URL lives.
app.post('/api/cron/setup', requireCron, ah(async (_req, res) => {
  await migrate();
  await seed();
  const results = [await syncSource('wsj', { full: true }), await syncSource('ba')];
  res.json({ results });
}));
app.post('/api/cron/tick', requireCron, runTick);

// ---------- owner only ----------
app.use('/api', requireOwner);

app.put('/api/jobs/:id/status', ah(async (req, res) => {
  const { status, notes } = req.body ?? {};
  const job = await one('SELECT id FROM jobs WHERE id = $1', [req.params.id]);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (status === null || status === '') {
    await q('DELETE FROM job_status WHERE job_id = $1', [job.id]);
    return res.json({ status: null });
  }
  if (!STATUSES.has(status)) return res.status(400).json({ error: 'Unknown status.' });
  const note = typeof notes === 'string' ? notes.slice(0, 2000) : null;
  const row = await one(`
    INSERT INTO job_status (job_id, status, notes, applied_at, updated_at)
    VALUES ($1, $2, COALESCE($3, ''), CASE WHEN $2 = ANY($4::text[]) THEN now() END, now())
    ON CONFLICT (job_id) DO UPDATE SET status = excluded.status,
      notes = COALESCE($3, job_status.notes),
      applied_at = COALESCE(job_status.applied_at, excluded.applied_at),
      updated_at = now()
    RETURNING status, applied_at`, [job.id, status, note, TRACKED]);
  res.json(row);
}));

app.get('/api/tracker', ah(async (_req, res) => {
  res.json(await q(`SELECT ${PUBLIC_COLUMNS}, s.status, s.notes, s.applied_at, s.updated_at AS status_updated_at
    FROM job_status s JOIN jobs j ON j.id = s.job_id WHERE s.status <> 'hidden'
    ORDER BY COALESCE(s.applied_at, s.updated_at) DESC LIMIT 1000`));
}));

const alertOut = async (a) => ({ ...a, summary: describeAlert(a.filters), ...(await alertCounts(a)) });

app.get('/api/alerts', ah(async (_req, res) => {
  const alerts = await q('SELECT * FROM alerts ORDER BY created_at DESC');
  res.json(await Promise.all(alerts.map(alertOut)));
}));

app.post('/api/alerts', ah(async (req, res) => {
  const { n } = await one('SELECT count(*)::int AS n FROM alerts');
  if (n >= 50) return res.status(400).json({ error: 'You have 50 alerts. Delete one before adding another.' });
  const filters = parseFilters(req.body?.filters ?? {});
  const name = String(req.body?.name || describeFilters(filters)).trim().slice(0, 120) || 'New jobs';
  const frequency = req.body?.frequency === 'daily' ? 'daily' : 'instant';
  const alert = await one('INSERT INTO alerts (name, filters, frequency) VALUES ($1, $2, $3) RETURNING *', [name, JSON.stringify(filters), frequency]);
  res.status(201).json(await alertOut(alert));
}));

app.put('/api/alerts/:id', ah(async (req, res) => {
  const a = await one('SELECT * FROM alerts WHERE id = $1', [Number(req.params.id) || 0]);
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
  await q('DELETE FROM alerts WHERE id = $1', [Number(req.params.id) || 0]);
  res.status(204).end();
}));

app.get('/api/settings', ah(async (_req, res) => {
  const parse = async (k) => { const v = await getSetting(k); return v ? JSON.parse(v) : null; };
  const { syncs, lastError } = await syncStatus();
  res.json({
    email: await getSetting('email', ''),
    mailProvider: mailProvider(),
    lastEmail: await parse('lastEmail'),
    lastEmailError: await parse('lastEmailError'),
    pollMinutes: 5,
    syncs,
    sync: { busy: false, lastError },
  });
}));

app.put('/api/settings', ah(async (req, res) => {
  const email = String(req.body?.email ?? '').trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address, like name@example.com.' });
  }
  await setSetting('email', email);
  res.json({ email });
}));

app.post('/api/email/test', ah(async (_req, res) => {
  try { res.json(await sendTestEmail()); } catch (err) { res.status(400).json({ error: err.message }); }
}));

app.get('/api/email/preview', ah(async (_req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src https:");
  res.type('html').send(await previewEmailHtml());
}));

app.post('/api/sync', ah(async (_req, res) => res.json(await syncSource('wsj'))));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: 'The request could not be read.' });
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again in a minute.' });
});
