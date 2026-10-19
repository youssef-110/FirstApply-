// workingstudentjobs.de public API (explicitly allowed in their robots.txt: /api/v1/jobs).
// Results are sorted newest first and paginated with an opaque cursor.
import { cleanTitle, dedupeKey, fetchJson, normalizeCity, sleep } from './normalize.js';

const BASE = 'https://www.workingstudentjobs.de/api/v1/jobs';
const PAGE_SIZE = 300; // API maximum
const MAX_PAGES = 200;

// Follow only "next" links that stay on this API, so a bad upstream response can't
// send our server to another host.
const safeNext = (next) => {
  if (!next) return null;
  try {
    const u = new URL(next, BASE);
    const base = new URL(BASE);
    return u.origin === base.origin && u.pathname === base.pathname ? u.href : null;
  } catch { return null; }
};

const LANG_LEVELS = new Set(['required', 'optional', 'not_required']);
const MODES = new Set(['remote', 'hybrid', 'onsite']);

export const normalize = (j) => {
  const city = normalizeCity(j.location?.city);
  return {
    id: `wsj:${j.id}`,
    source: 'wsj',
    source_id: j.id,
    title: cleanTitle(j.title),
    company: j.company?.name ?? 'Unknown company',
    company_logo: j.company?.logo_url ?? null,
    city,
    state: j.location?.state ?? null,
    lat: j.location?.latitude ?? null,
    lng: j.location?.longitude ?? null,
    types: j.types ?? [],
    field: j.field ?? 'other',
    sub_field: j.sub_field ?? null,
    working_mode: MODES.has(j.working_mode) ? j.working_mode : 'unknown',
    german: LANG_LEVELS.has(j.languages?.german) ? j.languages.german : 'unknown',
    english: LANG_LEVELS.has(j.languages?.english) ? j.languages.english : 'unknown',
    salary_min: j.salary?.min ?? null,
    salary_max: j.salary?.max ?? null,
    salary_currency: j.salary?.currency ?? null,
    salary_period: j.salary?.period ?? null,
    skills: j.skills ?? [],
    url: j.url,
    apply_url: j.apply_url || j.url,
    posted_at: j.posted_at ?? j.first_seen_at ?? null,
    dedupe_key: dedupeKey(j.company?.name, j.title, city),
  };
};

/**
 * Walks pages newest → oldest. `shouldStop(pageJobs)` lets incremental syncs end as soon as
 * they reach jobs already stored. Returns { jobs, complete } where complete means the walk
 * reached the last page (needed before marking unseen jobs as closed).
 */
export const fetchJobs = async ({ shouldStop } = {}) => {
  const jobs = [];
  const seen = new Set();
  let url = `${BASE}?limit=${PAGE_SIZE}`;
  for (let pages = 0; url; pages++) {
    // ~70 pages exist today; the cap stops a runaway cursor from looping forever.
    if (pages >= MAX_PAGES) return { jobs, complete: false };
    const page = await fetchJson(url);
    const batch = (page.data ?? []).map(normalize);
    jobs.push(...batch);
    if (await shouldStop?.(batch)) return { jobs, complete: false };
    url = safeNext(page.links?.next);
    if (url && seen.has(url)) return { jobs, complete: false };
    if (url) { seen.add(url); await sleep(250); }
  }
  return { jobs, complete: true };
};

/** Ids of the newest postings, used to skip a sync (and a database wake-up) when nothing changed. */
export const newestFingerprint = async () => {
  const page = await fetchJson(`${BASE}?limit=50`);
  return (page.data ?? []).map((j) => j.id).join(',');
};
