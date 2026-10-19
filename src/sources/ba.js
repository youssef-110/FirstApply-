// Bundesagentur für Arbeit job search API (public key used by the official Jobsuche app).
// Covers working-student jobs that never reach the private job boards. It has no language
// data, so those fields stay "unknown" instead of being guessed.
import { classifyField, cleanTitle, dedupeKey, fetchJson, normalizeCity, sleep } from './normalize.js';

const BASE = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs';
const HEADERS = { 'X-API-Key': 'jobboerse-jobsuche' };
const QUERIES = ['Werkstudent', 'Working Student'];
const PAGE_SIZE = 100;
const MAX_PAGES = 100; // safety stop per query

const detailUrl = (ref) => `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(ref)}`;

export const normalize = (j) => {
  const loc = j.stellenlokationen?.[0];
  const city = normalizeCity(loc?.adresse?.ort);
  const title = cleanTitle(j.stellenangebotsTitel ?? j.titel ?? 'Untitled');
  const isStudent = /werkstudent|working student|studentische/i.test(title);
  const isThesis = /abschlussarbeit|thesis|masterarbeit|bachelorarbeit/i.test(title);
  const types = [
    ...(isStudent ? ['working_student'] : []),
    ...(j.stellenangebotsart === 'PRAKTIKUM_TRAINEE' && !isStudent ? ['internship'] : []),
    ...(isThesis ? ['thesis'] : []),
  ];
  const { field, sub_field } = classifyField(title, j.hauptberuf, ...(j.alleBerufe ?? []));
  return {
    id: `ba:${j.referenznummer}`,
    source: 'ba',
    source_id: j.referenznummer,
    title,
    company: j.firma ?? 'Unknown company',
    company_logo: null,
    city,
    state: loc?.adresse?.region ? loc.adresse.region.charAt(0) + loc.adresse.region.slice(1).toLowerCase() : null,
    lat: loc?.breite ?? null,
    lng: loc?.laenge ?? null,
    types: types.length ? types : ['working_student'],
    field,
    sub_field,
    working_mode: j.homeofficemoeglich ? 'hybrid' : 'onsite',
    german: 'unknown',
    english: 'unknown',
    salary_min: null, salary_max: null, salary_currency: null, salary_period: null,
    skills: (j.alleBerufe ?? []).filter((b) => b !== j.hauptberuf).slice(0, 6),
    url: detailUrl(j.referenznummer),
    apply_url: j.externeURL || detailUrl(j.referenznummer),
    posted_at: j.datumErsteVeroeffentlichung ? `${j.datumErsteVeroeffentlichung}T00:00:00.000Z` : null,
    dedupe_key: dedupeKey(j.firma, title, city),
  };
};

export const fetchJobs = async () => {
  const byId = new Map();
  let complete = true;
  for (const was of QUERIES) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetchJson(`${BASE}?was=${encodeURIComponent(was)}&size=${PAGE_SIZE}&page=${page}`, HEADERS);
      const list = res.ergebnisliste ?? [];
      for (const raw of list) {
        // The keyword search also matches descriptions; keep only real student roles.
        const job = normalize(raw);
        if (/werkstudent|working student|studentische/i.test(job.title)) byId.set(job.id, job);
      }
      if (list.length < PAGE_SIZE) break;
      if (page === MAX_PAGES) complete = false;
      await sleep(250);
    }
  }
  return { jobs: [...byId.values()], complete };
};
