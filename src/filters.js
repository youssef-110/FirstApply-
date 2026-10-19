// One filter shape is used by the search page and by saved alerts, so an alert always
// matches exactly what the user saw when they created it.
//
// { q, cities[], fields[], subFields[], types[], modes[], german[], english[], sources[], sinceHours }

const LIST_KEYS = ['cities', 'fields', 'subFields', 'types', 'modes', 'german', 'english', 'sources'];

const asList = (v) => {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim().slice(0, 80)).filter(Boolean);
  if (typeof v === 'string' && v) return v.split(',').map((s) => s.trim().slice(0, 80)).filter(Boolean);
  return [];
};

export const parseFilters = (input = {}) => {
  input ??= {};
  const f = { q: typeof input.q === 'string' ? input.q.trim().slice(0, 100) : '' };
  for (const k of LIST_KEYS) f[k] = asList(input[k]).slice(0, 50);
  const since = Number(input.sinceHours);
  f.sinceHours = Number.isInteger(since) && since > 0 && since <= 24 * 365 ? since : null;
  return f;
};

/**
 * Returns { where, params } for the jobs table aliased as j. `params` may already hold
 * earlier parameters; placeholders continue from its length.
 */
export const buildWhere = (f, params = []) => {
  const p = (v) => { params.push(v); return `$${params.length}`; };
  const where = ['j.active', 'j.dup_of IS NULL'];

  if (f.q) {
    for (const word of f.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4)) {
      const like = p(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      where.push(`(j.title ILIKE ${like} OR j.company ILIKE ${like} OR j.skills::text ILIKE ${like})`);
    }
  }
  const any = (col, values) => values.length && where.push(`${col} = ANY(${p(values)}::text[])`);
  any('j.city', f.cities);
  any('j.field', f.fields);
  any('j.sub_field', f.subFields);
  any('j.working_mode', f.modes);
  any('j.german', f.german);
  any('j.english', f.english);
  any('j.source', f.sources);
  if (f.types.length) where.push(`j.types ?| ${p(f.types)}::text[]`);
  if (f.sinceHours) where.push(`j.posted_at >= now() - make_interval(hours => ${p(f.sinceHours)})`);
  return { where: where.join(' AND '), params };
};

const LABELS = {
  modes: { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' },
  types: { working_student: 'Working student', internship: 'Internship', thesis: 'Thesis' },
};

/** Short human description of a filter set, used for alert names and emails. */
export const describeFilters = (f) => {
  const parts = [];
  if (f.q) parts.push(`"${f.q}"`);
  if (f.types.length) parts.push(f.types.map((t) => LABELS.types[t] ?? t).join(' or '));
  if (f.subFields.length) parts.push(f.subFields.length > 2 ? `${f.subFields.length} tech areas` : f.subFields.join(', '));
  else if (f.fields.length) parts.push(f.fields.join(', '));
  if (f.cities.length) parts.push(`in ${f.cities.length > 3 ? `${f.cities.length} cities` : f.cities.join(', ')}`);
  if (f.modes.length && f.modes.length < 3) parts.push(f.modes.map((m) => LABELS.modes[m] ?? m).join('/'));
  if (f.german.length && !f.german.includes('required')) parts.push('no German needed');
  return parts.join(' · ') || 'All jobs';
};
