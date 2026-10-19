import { getCache } from '@vercel/functions';
import { acquireLock, getSetting, q, releaseLock, setSetting } from './db.js';
import * as wsj from './sources/wsj.js';
import * as ba from './sources/ba.js';
import { DIGEST_HOUR, berlinHour, queueNewJobs, sendPending } from './alerts.js';

export const SOURCES = {
  wsj: { label: 'workingstudentjobs.de', module: wsj },
  ba: { label: 'Bundesagentur für Arbeit', module: ba },
};

// Column name → Postgres array type used with unnest() for bulk upserts.
const COLUMNS = {
  id: 'text', source: 'text', source_id: 'text', title: 'text', company: 'text', company_logo: 'text',
  city: 'text', state: 'text', lat: 'float8', lng: 'float8', types: 'text', field: 'text', sub_field: 'text',
  working_mode: 'text', german: 'text', english: 'text', salary_min: 'float8', salary_max: 'float8',
  salary_currency: 'text', salary_period: 'text', skills: 'text', url: 'text', apply_url: 'text',
  posted_at: 'timestamptz', dedupe_key: 'text',
};
const NAMES = Object.keys(COLUMNS);
const JSON_COLS = new Set(['types', 'skills']);
const UPDATABLE = NAMES.filter((c) => !['id', 'source', 'source_id'].includes(c));

const UPSERT = `
  INSERT INTO jobs (${NAMES.join(', ')}, first_seen_at, last_seen_at, active)
  SELECT ${NAMES.map((c) => (JSON_COLS.has(c) ? `u.${c}::jsonb` : `u.${c}`)).join(', ')}, now(), now(), true
  FROM unnest(${NAMES.map((c, i) => `$${i + 1}::${COLUMNS[c]}[]`).join(', ')}) AS u(${NAMES.join(', ')})
  ON CONFLICT (id) DO UPDATE SET ${UPDATABLE.map((c) => `${c} = excluded.${c}`).join(', ')}, last_seen_at = now(), active = true
  RETURNING id, (xmax = 0) AS inserted`;

/** Upserts jobs in chunks; returns ids of jobs we had never seen before. */
const store = async (allJobs) => {
  // Paginated sources can repeat a job across pages; one upsert may not touch a row twice.
  const jobs = [...new Map(allJobs.map((j) => [j.id, j])).values()];
  const inserted = [];
  for (let i = 0; i < jobs.length; i += 500) {
    const chunk = jobs.slice(i, i + 500);
    const params = NAMES.map((c) => chunk.map((j) => (JSON_COLS.has(c) ? JSON.stringify(j[c] ?? []) : j[c] ?? null)));
    for (const row of await q(UPSERT, params)) if (row.inserted) inserted.push(row.id);
  }
  if (!inserted.length) return [];

  // Same posting on both sources: keep the richer workingstudentjobs.de listing visible.
  await q(`
    UPDATE jobs b SET dup_of = w.id FROM jobs w
    WHERE b.source = 'ba' AND w.source = 'wsj' AND b.dedupe_key = w.dedupe_key
      AND b.dup_of IS NULL AND w.dup_of IS NULL AND w.active
      AND (b.id = ANY($1::text[]) OR w.id = ANY($1::text[]))`, [inserted]);
  return (await q('SELECT id FROM jobs WHERE id = ANY($1::text[]) AND dup_of IS NULL', [inserted])).map((r) => r.id);
};

/** Syncs one source. `full` walks every page and marks jobs that disappeared as closed. */
export const syncSource = async (source, { full = false } = {}) => {
  const lock = await acquireLock(source, 290);
  if (!lock) return { source, skipped: 'already running' };
  const startedAt = new Date().toISOString();
  try {
    const bootstrapped = (await getSetting(`bootstrapped:${source}`)) === '1';
    let shouldStop;
    if (source === 'wsj' && !full && bootstrapped) {
      // Newest first: stop once a whole page is already known.
      shouldStop = async (batch) => {
        if (!batch.length) return true;
        const known = await q('SELECT count(*)::int AS n FROM jobs WHERE id = ANY($1::text[])', [batch.map((j) => j.id)]);
        return known[0].n === batch.length;
      };
    }
    const { jobs, complete } = await SOURCES[source].module.fetchJobs({ shouldStop });
    const fresh = await store(jobs);

    let closed = 0;
    if (complete && jobs.length > 0) {
      closed = (await q('UPDATE jobs SET active = false WHERE source = $1 AND active AND last_seen_at < $2 RETURNING id',
        [source, startedAt])).length;
    }
    // The first import fills the database; it must not email thousands of "new" jobs.
    if (bootstrapped) await queueNewJobs(fresh);
    else await setSetting(`bootstrapped:${source}`, '1');

    const result = { at: new Date().toISOString(), fetched: jobs.length, new: fresh.length, closed, full: complete };
    await setSetting(`lastSync:${source}`, JSON.stringify(result));
    await setSetting('lastError', '');
    console.log(`[sync] ${source}${complete ? ' full' : ''}: ${jobs.length} fetched, ${fresh.length} new, ${closed} closed`);
    return { source, ...result };
  } catch (err) {
    await setSetting('lastError', JSON.stringify({ source, message: err.message, at: new Date().toISOString() })).catch(() => {});
    console.error(`[sync] ${source} failed:`, err.message);
    return { source, error: err.message };
  } finally {
    await releaseLock(source, lock).catch(() => {});
  }
};

/**
 * One scheduler tick (every 5 minutes). The database is only touched when the newest
 * postings changed or a periodic job is due, so the serverless database can sleep.
 */
export const tick = async ({ now = new Date(), force = false } = {}) => {
  const h = now.getUTCHours();
  const firstTickOfHour = now.getUTCMinutes() < 5;
  const baDue = force || (firstTickOfHour && h % 2 === 0);      // every 2 hours
  const fullDue = force || (firstTickOfHour && (h === 3 || h === 15)); // twice a day
  const digestDue = firstTickOfHour && berlinHour(now) === DIGEST_HOUR; // daily-digest alerts

  const cache = getCache();
  const fingerprint = await wsj.newestFingerprint();
  const unchanged = !force && (await cache.get('wsj:fingerprint').catch(() => null)) === fingerprint;
  if (unchanged && !baDue && !fullDue && !digestDue) return { skipped: 'no new postings' };

  const results = [];
  if (fullDue) results.push(await syncSource('wsj', { full: true }));
  else if (!unchanged) results.push(await syncSource('wsj'));
  if (baDue) results.push(await syncSource('ba'));
  if (!results.some((r) => r.error)) await cache.set('wsj:fingerprint', fingerprint, { ttl: 86400 }).catch(() => {});
  results.push({ email: await sendPending() });
  return { results };
};

export const syncStatus = async () => {
  const syncs = {};
  for (const s of Object.keys(SOURCES)) {
    const raw = await getSetting(`lastSync:${s}`);
    syncs[s] = { label: SOURCES[s].label, ...(raw ? JSON.parse(raw) : {}) };
  }
  const err = await getSetting('lastError');
  return { syncs, lastError: err ? JSON.parse(err) : null };
};
