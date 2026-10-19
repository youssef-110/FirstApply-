// Firstapply front end: hash-routed single page app, no build step.

// ---------- labels ----------
const FIELD_LABELS = {
  tech: 'Tech & IT', engineering: 'Engineering', operations: 'Operations', sales: 'Sales', marketing: 'Marketing',
  finance: 'Finance', hr: 'HR', consulting: 'Consulting', legal: 'Legal', design: 'Design', logistics: 'Logistics',
  research: 'Research', healthcare: 'Healthcare', other: 'Other',
};
const SUB_LABELS = {
  'software-engineering': 'Software engineering', 'ai-ml': 'AI & machine learning', 'it-support': 'IT support',
  'cloud-devops': 'Cloud & DevOps', 'data-engineering': 'Data engineering', 'embedded-systems': 'Embedded systems',
  cybersecurity: 'Cybersecurity', 'qa-testing': 'QA & testing', 'data-analytics': 'Data analytics',
  'product-management': 'Product management', 'business-intelligence': 'Business intelligence', 'sap-erp': 'SAP & ERP',
};
const TYPE_LABELS = { working_student: 'Working student', internship: 'Internship', thesis: 'Thesis' };
const MODE_LABELS = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site', unknown: 'Not stated' };
const LANG_LABELS = { not_required: 'Not required', optional: 'Nice to have', required: 'Required', unknown: 'Not stated' };
const STATUS_LABELS = { saved: 'Saved', applied: 'Applied', interviewing: 'Interviewing', offer: 'Offer', rejected: 'Rejected', hidden: 'Not interested' };
const SOURCE_LABELS = { wsj: 'workingstudentjobs.de', ba: 'Bundesagentur für Arbeit' };
const SINCE = [[null, 'Any time'], [24, 'Past 24 hours'], [72, 'Past 3 days'], [168, 'Past week'], [720, 'Past month']];
const TRACK_STATUSES = ['applied', 'interviewing', 'offer', 'rejected'];

const DEFAULT_FILTERS = {
  q: '', cities: ['Berlin'], fields: ['tech'],
  subFields: ['software-engineering', 'ai-ml', 'it-support', 'cloud-devops', 'data-engineering', 'embedded-systems', 'cybersecurity', 'qa-testing', 'data-analytics'],
  types: [], modes: [], german: [], english: [], sources: [], sinceHours: null,
};
const LIST_KEYS = ['cities', 'fields', 'subFields', 'types', 'modes', 'german', 'english', 'sources'];

const labelSub = (s) => SUB_LABELS[s] ?? s.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
const labelField = (f) => FIELD_LABELS[f] ?? f;

// ---------- utils ----------
const $ = (sel, root = document) => root.querySelector(sel);
// Only http(s) links from job sources are clickable.
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '#');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d < 31) return d === 1 ? 'yesterday' : `${d} days ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
// Some sources only publish a date, not a time: show those as days, never "7 h ago".
const postedAgo = (j) => {
  if (!j.posted_at?.endsWith('T00:00:00.000Z')) return ago(j.posted_at);
  const days = Math.round((new Date().setUTCHours(0, 0, 0, 0) - new Date(j.posted_at)) / 86400_000);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 31 ? `${days} days ago` : fmtDate(j.posted_at);
};
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const nf = new Intl.NumberFormat('en-US');

const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const logo = (job, cls = '') => {
  const initials = job.company.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const fallback = `<div class="logo logo-fallback ${cls}" style="background:hsl(${hue(job.company)} 45% 42%)" aria-hidden="true">${esc(initials)}</div>`;
  if (!/^https:\/\//i.test(job.company_logo ?? '')) return fallback;
  return `<img class="logo ${cls}" src="${esc(job.company_logo)}" alt="" loading="lazy" data-fallback="${esc(fallback)}">`;
};
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.dataset.fallback) img.outerHTML = img.dataset.fallback;
}, true);

const salary = (j) => {
  if (!j.salary_min) return null;
  const per = { month: 'month', hour: 'hour', year: 'year' }[j.salary_period] ?? j.salary_period ?? 'month';
  const n = (v) => `€${nf.format(Math.round(v))}`;
  const range = j.salary_max && j.salary_max !== j.salary_min ? `–${n(j.salary_max)}` : j.salary_max ? '' : '+';
  return `${n(j.salary_min)}${range} / ${per}`;
};

const langTag = (j) => {
  if (j.german === 'not_required') return '<span class="tag tag-green">No German needed</span>';
  if (j.german === 'optional') return '<span class="tag tag-green">German a plus</span>';
  if (j.german === 'required') return '<span class="tag tag-amber">German required</span>';
  return '<span class="tag">Language not stated</span>';
};

const toast = (msg, action) => {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { action.run(); el.remove(); };
  $('#toasts').append(el);
  setTimeout(() => el.remove(), action ? 9000 : 3500);
};

const icons = {
  bookmark: '<svg viewBox="0 0 24 24"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Zm1 2v12.6l5-2.9 5 2.9V5H7Z"/></svg>',
  bookmarkFill: '<svg viewBox="0 0 24 24"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M12 22a2.5 2.5 0 0 0 2.4-2h-4.8a2.5 2.5 0 0 0 2.4 2Zm7-6V11a7 7 0 0 0-5.5-6.8V3a1.5 1.5 0 0 0-3 0v1.2A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2Z"/></svg>',
  external: '<svg viewBox="0 0 24 24"><path d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3ZM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2Z"/></svg>',
};

// ---------- app state ----------
const state = {
  filters: { ...DEFAULT_FILTERS, ...store.get('filters', {}) },
  sort: store.get('sort', 'newest'),
  facets: null,
  jobs: [], total: 0, page: 1, summary: '',
  selectedId: null,
  lastVisit: store.get('lastVisit', new Date().toISOString()),
  settings: null,
  user: null,
  admin: false,
};
// Mark everything older than this visit as seen a few seconds after opening the app.
setTimeout(() => store.set('lastVisit', new Date().toISOString()), 5000);

const filtersToQuery = (f) => {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  for (const k of LIST_KEYS) if (f[k]?.length) p.set(k, f[k].join(','));
  if (f.sinceHours) p.set('sinceHours', f.sinceHours);
  return p;
};
const setFilters = (patch) => {
  state.filters = { ...state.filters, ...patch };
  store.set('filters', state.filters);
  loadJobs();
};

// ---------- router ----------
const routes = { jobs: renderJobsPage, saved: renderSaved, applied: renderApplied, alerts: renderAlerts };
function route() {
  const [, tab = 'jobs', id] = location.hash.match(/^#\/(\w+)(?:\/(.+))?/) ?? [];
  const page = Object.hasOwn(routes, tab) ? tab : 'jobs';
  document.querySelectorAll('.tabs a').forEach((a) => {
    if (a.dataset.tab === page) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (page !== 'jobs' && !state.user) return renderSignInPage(page);
  let jobId = null;
  try { jobId = id ? decodeURIComponent(id) : null; } catch { /* malformed link: show the list */ }
  routes[page](jobId);
}
window.addEventListener('hashchange', route);

// ---------- search bar ----------
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  const loc = $('#loc').value.trim();
  const city = loc ? (state.facets?.cities.find((c) => c.value.toLowerCase() === loc.toLowerCase())?.value ?? loc) : null;
  if (!location.hash.startsWith('#/jobs')) location.hash = '#/jobs';
  setFilters({ q, cities: city ? [city] : [] });
});
const syncSearchInputs = () => {
  $('#q').value = state.filters.q;
  $('#loc').value = state.filters.cities.length === 1 ? state.filters.cities[0] : '';
  $('#loc').placeholder = state.filters.cities.length > 1 ? `${state.filters.cities.length} cities` : 'City';
};

// ---------- jobs page ----------
const filterDefs = () => [
  { key: 'cities', label: 'Location', searchable: true,
    options: (state.facets?.cities ?? []).map((c) => ({ value: c.value, label: c.value, n: c.n })) },
  { key: 'types', label: 'Job type', options: Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label })) },
  { key: 'fields', label: 'Field', options: (state.facets?.fields ?? []).map((f) => ({ value: f.value, label: labelField(f.value), n: f.n })) },
  { key: 'subFields', label: 'Tech area',
    options: (state.facets?.subFields ?? []).filter((s) => s.field === 'tech')
      .reduce((acc, s) => { const ex = acc.find((a) => a.value === s.value); if (ex) ex.n += s.n; else acc.push({ value: s.value, label: labelSub(s.value), n: s.n }); return acc; }, []) },
  { key: 'modes', label: 'Work mode', options: ['remote', 'hybrid', 'onsite'].map((value) => ({ value, label: MODE_LABELS[value] })) },
  { key: 'language', label: 'Language', groups: [
    { key: 'german', title: 'German', options: ['not_required', 'optional', 'required', 'unknown'].map((value) => ({ value, label: LANG_LABELS[value] })) },
    { key: 'english', title: 'English', options: ['required', 'optional', 'not_required', 'unknown'].map((value) => ({ value, label: LANG_LABELS[value] })) },
  ] },
  { key: 'sinceHours', label: 'Date posted', radio: true, options: SINCE.map(([value, label]) => ({ value, label })) },
  { key: 'sources', label: 'Source', options: Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label })) },
];

const activeCount = (def) => {
  if (def.groups) return def.groups.reduce((n, g) => n + state.filters[g.key].length, 0);
  if (def.radio) return state.filters[def.key] ? 1 : 0;
  return state.filters[def.key].length;
};

const chipLabel = (def) => {
  if (def.radio) return SINCE.find(([v]) => v === state.filters.sinceHours)?.[1] ?? def.label;
  if (def.key === 'cities' && state.filters.cities.length === 1) return state.filters.cities[0];
  if (def.key === 'language' && state.filters.german.length && state.filters.german.every((g) => g !== 'required' && g !== 'unknown')) return 'No German needed';
  return def.label;
};

function renderFilterBar() {
  const bar = $('#filterbar');
  if (!bar) return;
  const defs = filterDefs();
  const anyActive = defs.some((d) => activeCount(d)) || state.filters.q;
  bar.innerHTML = `
    ${defs.map((d) => {
      const n = activeCount(d);
      const showBadge = n > 0 && !d.radio && !(d.key === 'cities' && n === 1) && chipLabel(d) === d.label;
      return `<div class="chip-wrap"><button type="button" class="chip ${n ? 'active' : ''}" data-filter="${d.key}" aria-expanded="false" aria-haspopup="true">
        ${esc(chipLabel(d))}${showBadge ? `<span class="chip-badge">${n}</span>` : ''}${icons.chevron}</button></div>`;
    }).join('')}
    ${anyActive ? '<button type="button" class="btn btn-ghost btn-sm" id="reset">Reset</button>' : ''}
    <div class="spacer"></div>
    <label class="visually-hidden" for="sort">Sort by</label>
    <select class="select btn-sm" id="sort" style="width:auto;height:34px;font-weight:600;font-size:13.5px">
      <option value="newest">Most recent</option><option value="discovered">Recently found</option><option value="salary">Highest salary</option>
    </select>
    <button type="button" class="btn btn-sm" id="create-alert">${icons.bell}Create alert</button>`;
  $('#sort').value = state.sort;
  $('#sort').onchange = (e) => { state.sort = e.target.value; store.set('sort', state.sort); loadJobs(); };
  $('#reset')?.addEventListener('click', () => { setFilters({ ...Object.fromEntries(LIST_KEYS.map((k) => [k, []])), q: '', sinceHours: null }); syncSearchInputs(); });
  $('#create-alert').onclick = () => openAlertModal();
  bar.querySelectorAll('[data-filter]').forEach((btn) => btn.addEventListener('click', () => togglePopover(btn, defs.find((d) => d.key === btn.dataset.filter))));
}

let openPop = null;
const closePopover = () => {
  if (!openPop) return;
  openPop.btn.setAttribute('aria-expanded', 'false');
  openPop.el.remove();
  openPop = null;
};
// isConnected: clicks on popover content that re-rendered itself must not count as "outside".
document.addEventListener('click', (e) => { if (openPop && e.target.isConnected && !openPop.el.contains(e.target) && !openPop.btn.contains(e.target)) closePopover(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPop) { const b = openPop.btn; closePopover(); b.focus(); } });

function togglePopover(btn, def) {
  if (openPop?.btn === btn) return closePopover();
  closePopover();
  // Draft selection; applied on "Show results" so the list doesn't jump while ticking boxes.
  const draft = def.groups
    ? Object.fromEntries(def.groups.map((g) => [g.key, new Set(state.filters[g.key])]))
    : def.radio ? { [def.key]: state.filters[def.key] } : { [def.key]: new Set(state.filters[def.key]) };

  const el = document.createElement('div');
  el.className = 'popover';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', def.label);
  const optHtml = (key, o, radio) => `<label class="opt"><input type="${radio ? 'radio' : 'checkbox'}" name="${key}" value="${esc(o.value ?? '')}"
      ${radio ? (draft[key] === o.value ? 'checked' : '') : (draft[key].has(String(o.value)) ? 'checked' : '')}>
      <span>${esc(o.label)}</span>${o.n != null ? `<span class="n">${nf.format(o.n)}</span>` : ''}</label>`;
  const renderBody = (term = '') => {
    if (def.groups) {
      return `<button type="button" class="btn btn-sm opt-preset" data-preset="english">Only jobs without German</button>` +
        def.groups.map((g) => `<div class="popover-group"><div class="popover-title">${g.title}</div>${g.options.map((o) => optHtml(g.key, o)).join('')}</div>`).join('');
    }
    let opts = def.options;
    if (term) opts = opts.filter((o) => o.label.toLowerCase().includes(term.toLowerCase()));
    else if (def.searchable) opts = [...opts.filter((o) => draft[def.key].has(o.value)), ...opts.filter((o) => !draft[def.key].has(o.value)).slice(0, 40)];
    return opts.map((o) => optHtml(def.key, o, def.radio)).join('') || '<p class="hint" style="padding:8px">No matches.</p>';
  };
  el.innerHTML = `
    ${def.searchable ? '<div class="popover-search"><input class="input" type="search" placeholder="Search cities" aria-label="Search cities"></div>' : ''}
    <div class="popover-body">${renderBody()}</div>
    <div class="popover-foot"><button type="button" class="btn btn-ghost btn-sm" data-clear>Clear</button><button type="button" class="btn btn-primary btn-sm" data-apply>Show results</button></div>`;
  btn.parentElement.append(el);
  btn.setAttribute('aria-expanded', 'true');
  openPop = { btn, el };

  const body = el.querySelector('.popover-body');
  el.addEventListener('change', (e) => {
    const { name, value, checked, type } = e.target;
    if (!(name in draft)) return;
    if (type === 'radio') draft[name] = value === '' ? null : Number(value);
    else checked ? draft[name].add(value) : draft[name].delete(value);
  });
  el.querySelector('[data-preset]')?.addEventListener('click', () => {
    draft.german = new Set(['not_required', 'optional']);
    draft.english = new Set();
    body.innerHTML = renderBody();
  });
  const search = el.querySelector('input[type=search]');
  if (search) { search.addEventListener('input', () => { body.innerHTML = renderBody(search.value); }); search.focus(); }
  else el.querySelector('input')?.focus();
  el.querySelector('[data-clear]').onclick = () => {
    for (const k of Object.keys(draft)) draft[k] = def.radio ? null : new Set();
    body.innerHTML = renderBody(search?.value ?? '');
  };
  el.querySelector('[data-apply]').onclick = () => {
    const patch = Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v instanceof Set ? [...v] : v]));
    closePopover();
    setFilters(patch);
    syncSearchInputs();
  };
}

function renderJobsPage(id) {
  if (!$('#jobs-root')) {
    $('#main').innerHTML = `
      <div class="filterbar"><div class="filterbar-inner" id="filterbar"></div></div>
      <div class="jobs-layout" id="jobs-root">
        <section aria-labelledby="results-title">
          <div class="results-head"><div><h1 id="results-title">Loading jobs</h1><div class="hint" id="results-sub"></div></div><span class="radar" id="radar"><span class="radar-dot"></span><span></span></span></div>
          <div class="list" id="list">${'<div class="skeleton"></div>'.repeat(5)}</div>
          <button type="button" class="btn more" id="more" hidden>Show more jobs</button>
        </section>
        <aside class="detail" id="detail" aria-label="Job details"><div class="empty-detail">Select a job to see the details.</div></aside>
      </div>`;
    $('#more').onclick = () => loadJobs({ append: true });
    renderFilterBar();
    renderRadar();
    loadJobs({ selectId: id });
  } else if (id) {
    selectJob(id);
  } else {
    $('#detail').classList.remove('open');
  }
}

let loadSeq = 0;
async function loadJobs({ append = false, selectId = null } = {}) {
  if (!$('#list')) return;
  const seq = ++loadSeq;
  state.page = append ? state.page + 1 : 1;
  const p = filtersToQuery(state.filters);
  p.set('sort', state.sort); p.set('page', state.page); p.set('size', 30);
  renderFilterBar();
  try {
    const data = await api(`/api/jobs?${p}`);
    if (seq !== loadSeq) return;
    state.jobs = append ? [...state.jobs, ...data.items] : data.items;
    state.total = data.total;
    state.summary = data.summary;
    renderList();
    if (!append) {
      const target = selectId ?? (window.matchMedia('(min-width: 861px)').matches ? state.jobs[0]?.id : null);
      if (target) selectJob(target, { scroll: false });
      else if (!state.jobs.length) $('#detail').innerHTML = '<div class="empty-detail">No job selected.</div>';
    }
  } catch (err) {
    $('#list').innerHTML = `<div class="panel empty"><h2>Jobs couldn't load</h2><p>${esc(err.message)}. Reload the page to try again.</p></div>`;
  }
}

function renderList() {
  $('#results-title').textContent = `${nf.format(state.total)} ${state.total === 1 ? 'job' : 'jobs'}`;
  $('#results-sub').textContent = state.summary;
  const list = $('#list');
  if (!state.jobs.length) {
    list.innerHTML = `<div class="panel empty"><h2>No jobs match these filters</h2><p>Remove a filter or try another city. You can still create an alert, and you'll get an email when a matching job is posted.</p><button type="button" class="btn btn-primary" id="empty-alert">${icons.bell}Create alert for this search</button></div>`;
    $('#empty-alert').onclick = () => openAlertModal();
  } else {
    list.innerHTML = state.jobs.map(cardHtml).join('');
  }
  $('#more').hidden = state.jobs.length >= state.total;
}

const isFresh = (j) => j.first_seen_at > state.lastVisit && Date.now() - new Date(j.posted_at ?? j.first_seen_at) < 3 * 86400_000;

function cardHtml(j) {
  const saved = j.status === 'saved';
  return `<article class="card" data-id="${esc(j.id)}" tabindex="0" ${j.id === state.selectedId ? 'aria-current="true"' : ''}>
    ${logo(j)}
    <div>
      <h2 class="card-title">${esc(j.title)}</h2>
      <div class="card-company">${esc(j.company)}${j.city ? `, ${esc(j.city)}` : ''}</div>
      <div class="card-meta">
        ${j.working_mode !== 'unknown' ? `<span class="tag">${esc(MODE_LABELS[j.working_mode])}</span>` : ''}
        ${langTag(j)}
        ${salary(j) ? `<span class="tag tag-blue">${esc(salary(j))}</span>` : ''}
      </div>
      <div class="card-foot">${isFresh(j) ? '<span class="fresh">New</span>' : ''}<span>Posted ${postedAgo(j)}</span></div>
    </div>
    <button type="button" class="icon-btn" data-save aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved' : 'Save job'}">${saved ? icons.bookmarkFill : icons.bookmark}</button>
  </article>`;
}

document.addEventListener('click', async (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('[data-save]')) {
    if (!state.user) return openLogin();
    const job = state.jobs.find((j) => j.id === id);
    await setStatus(id, job?.status === 'saved' ? null : 'saved');
    return;
  }
  location.hash = `#/jobs/${encodeURIComponent(id)}`;
});
document.addEventListener('keydown', (e) => {
  const card = e.target.closest?.('.card');
  if (card && (e.key === 'Enter' || e.key === ' ') && !e.target.closest('button')) { e.preventDefault(); card.click(); }
});

async function selectJob(id, { scroll = true } = {}) {
  state.selectedId = id;
  document.querySelectorAll('.card').forEach((c) => {
    if (c.dataset.id === id) c.setAttribute('aria-current', 'true');
    else c.removeAttribute('aria-current');
  });
  const detail = $('#detail');
  if (!detail) return;
  let job = state.jobs.find((j) => j.id === id);
  try { job = await api(`/api/jobs/${encodeURIComponent(id)}`); } catch (err) {
    if (!job) { detail.innerHTML = `<div class="empty-detail">${esc(err.message)}</div>`; detail.classList.add('open'); return; }
  }
  renderDetail(job);
  if (scroll && window.matchMedia('(max-width: 860px)').matches) detail.classList.add('open');
  if (!scroll) detail.scrollTop = 0;
}

function renderDetail(j) {
  const detail = $('#detail');
  const types = j.types.map((t) => TYPE_LABELS[t] ?? t).join(', ');
  const area = j.sub_field ? labelSub(j.sub_field) : null;
  detail.innerHTML = `
    <button type="button" class="btn btn-ghost btn-sm back-btn" id="back">${icons.back}Back to results</button>
    <div class="detail-head">
      <div class="detail-company">${logo(j, 'logo-lg')}<span>${esc(j.company)}</span></div>
      <h2>${esc(j.title)}</h2>
      <div class="detail-sub">${[j.city, j.state && j.state !== j.city ? j.state : null].filter(Boolean).map(esc).join(', ') || 'Germany'}${j.working_mode !== 'unknown' ? ` (${esc(MODE_LABELS[j.working_mode])})` : ''}</div>
      <div class="card-meta">${langTag(j)}${salary(j) ? `<span class="tag tag-blue">${esc(salary(j))}</span>` : ''}${!j.active ? '<span class="tag tag-red">No longer listed</span>' : ''}</div>
      <div class="detail-actions">
        <a class="btn btn-primary" href="${esc(safeUrl(j.apply_url))}" target="_blank" rel="noopener noreferrer" id="apply">Apply${icons.external}</a>
        <button type="button" class="btn" id="save">${j.status === 'saved' ? icons.bookmarkFill + 'Saved' : icons.bookmark + 'Save'}</button>
        <label class="visually-hidden" for="status">Application status</label>
        <select class="select" id="status" ${state.user ? '' : 'hidden'}>
          <option value="">Not applied</option>
          ${['saved', ...TRACK_STATUSES, 'hidden'].map((s) => `<option value="${s}" ${j.status === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
        </select>
      </div>
      <div id="apply-confirm"></div>
    </div>
    <div class="detail-body">
      <section><h3>About this job</h3>
        <dl class="facts">
          <div><dt>Type</dt><dd>${esc(types || 'Not stated')}</dd></div>
          <div><dt>Field</dt><dd>${esc(area ? `${labelField(j.field)}: ${area}` : labelField(j.field))}</dd></div>
          <div><dt>German</dt><dd>${esc(LANG_LABELS[j.german])}</dd></div>
          <div><dt>English</dt><dd>${esc(LANG_LABELS[j.english])}</dd></div>
          <div><dt>Posted</dt><dd>${fmtDate(j.posted_at)}</dd></div>
          <div><dt>Work mode</dt><dd>${esc(MODE_LABELS[j.working_mode])}</dd></div>
          ${j.applied_at ? `<div><dt>You applied</dt><dd>${fmtDate(j.applied_at)}</dd></div>` : ''}
        </dl>
      </section>
      ${j.skills.length ? `<section><h3>${j.source === 'ba' ? 'Related occupations' : 'Skills'}</h3><div class="skills">${j.skills.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div></section>` : ''}
      ${state.user ? `<section><h3>Your notes</h3>
        <label class="visually-hidden" for="notes">Notes</label>
        <textarea class="textarea" id="notes" placeholder="Contact person, deadline, what to mention in the cover letter">${esc(j.notes ?? '')}</textarea>
      </section>` : ''}
      <p class="source-note">Listed on ${esc(SOURCE_LABELS[j.source])}. <a href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener noreferrer">View the original posting</a>${j.source === 'ba' ? '. This source doesn\'t state language requirements, so check the posting.' : '.'}</p>
    </div>`;
  $('#back').onclick = () => { detail.classList.remove('open'); history.replaceState(null, '', '#/jobs'); };
  $('#save').onclick = () => setStatus(j.id, j.status === 'saved' ? null : 'saved');
  $('#status').onchange = (e) => setStatus(j.id, e.target.value || null);
  $('#apply').addEventListener('click', () => {
    if (!state.user || TRACK_STATUSES.includes(j.status)) return;
    // After opening the employer's page, ask once so the tracker stays accurate.
    $('#apply-confirm').innerHTML = `<div class="apply-confirm"><span>Did you apply?</span><button type="button" class="btn btn-primary btn-sm" id="mark-applied">Mark as applied</button><button type="button" class="btn btn-ghost btn-sm" id="not-yet">Not yet</button></div>`;
    $('#mark-applied').onclick = () => setStatus(j.id, 'applied');
    $('#not-yet').onclick = () => { $('#apply-confirm').innerHTML = ''; };
  });
  let t;
  $('#notes')?.addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => api(`/api/jobs/${encodeURIComponent(j.id)}/status`, { method: 'PUT', body: { status: j.status || 'saved', notes: e.target.value } })
      .then(() => { if (!j.status) { j.status = 'saved'; refreshJob(j.id, 'saved'); } }), 600);
  });
}

async function setStatus(id, status) {
  if (!state.user) return openLogin();
  try {
    await api(`/api/jobs/${encodeURIComponent(id)}/status`, { method: 'PUT', body: { status } });
  } catch (err) { return toast(err.message); }
  refreshJob(id, status);
  const msg = { saved: 'Saved', applied: 'Marked as applied', interviewing: 'Moved to interviewing', offer: 'Marked as offer', rejected: 'Marked as rejected', hidden: 'Hidden from your results' }[status] ?? 'Removed from your list';
  toast(msg, status && status !== 'saved' ? { label: 'Undo', run: () => setStatus(id, null) } : null);
  updateCounts();
}

function refreshJob(id, status) {
  const job = state.jobs.find((j) => j.id === id);
  if (job) job.status = status;
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  // Applied and hidden jobs move to the tracker, so take them out of the feed.
  if (card && status && status !== 'saved') {
    card.remove();
    state.jobs = state.jobs.filter((j) => j.id !== id);
    state.total -= 1;
    $('#results-title').textContent = `${nf.format(state.total)} jobs`;
  } else if (card && job) card.outerHTML = cardHtml(job);
  if (state.selectedId === id && $('#detail')) selectJob(id, { scroll: false });
  if (location.hash.startsWith('#/saved') || location.hash.startsWith('#/applied')) route();
}

// ---------- alerts modal ----------
function openAlertModal() {
  if (!state.user) return openLogin({ then: openAlertModal });
  const modal = $('#modal');
  const f = state.filters;
  modal.innerHTML = `<form method="dialog" id="alert-form">
    <div class="modal-body">
      <h2>Create alert</h2>
      <p class="hint" style="margin:-8px 0 0">You'll get an email with the apply link when a new job matches this search: ${esc(state.summary || 'all jobs')}.</p>
      <div><label class="label" for="alert-name">Alert name</label><input class="input" id="alert-name" required maxlength="120" value="${esc(state.summary || 'New jobs')}"></div>
      <div><label class="label" for="alert-freq">How often</label>
        <select class="select" id="alert-freq"><option value="instant">As soon as a job is posted</option><option value="daily">Once a day</option></select></div>
      <p class="hint" style="margin:0">Emails go to <strong>${esc(state.user?.email ?? 'your address')}</strong>.</p>
    </div>
    <div class="modal-foot"><button type="button" class="btn btn-ghost" value="cancel" id="alert-cancel">Cancel</button><button class="btn btn-primary" type="submit">Create alert</button></div>
  </form>`;
  modal.showModal();
  $('#alert-cancel').onclick = () => modal.close();
  $('#alert-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/api/alerts', { method: 'POST', body: { name: $('#alert-name').value, frequency: $('#alert-freq').value, filters: f } });
      modal.close();
      toast('Alert created', { label: 'View alerts', run: () => { location.hash = '#/alerts'; } });
    } catch (err) { toast(err.message); }
  };
}

// ---------- saved & applied ----------
async function loadTracker() { return api('/api/tracker'); }

async function renderSaved() {
  $('#main').innerHTML = `<div class="page"><div class="page-head"><div><h1>Saved jobs</h1><p>Jobs you bookmarked to look at later.</p></div></div><div id="saved-list" class="list"><div class="skeleton"></div></div></div>`;
  const items = (await loadTracker()).filter((j) => j.status === 'saved');
  state.jobs = items;
  $('#saved-list').innerHTML = items.length ? items.map(cardHtml).join('')
    : `<div class="panel empty"><h2>No saved jobs yet</h2><p>Use the bookmark on any job to keep it here.</p><a class="btn btn-primary" href="#/jobs">Browse jobs</a></div>`;
}

let trackerFilter = 'all';
async function renderApplied() {
  $('#main').innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Applications</h1><p>Every job you applied to, and where each one stands.</p></div><div class="seg" id="seg"></div></div>
    <div class="panel" id="tracker"><div class="panel-pad"><div class="skeleton" style="height:180px"></div></div></div></div>`;
  const all = (await loadTracker()).filter((j) => TRACK_STATUSES.includes(j.status));
  const counts = Object.fromEntries(TRACK_STATUSES.map((s) => [s, all.filter((j) => j.status === s).length]));
  $('#seg').innerHTML = [['all', 'All', all.length], ...TRACK_STATUSES.map((s) => [s, STATUS_LABELS[s], counts[s]])]
    .map(([k, label, n]) => `<button type="button" data-k="${k}" aria-pressed="${trackerFilter === k}">${label} <span class="n">${n}</span></button>`).join('');
  $('#seg').onclick = (e) => { const b = e.target.closest('button'); if (b) { trackerFilter = b.dataset.k; renderApplied(); } };
  const rows = trackerFilter === 'all' ? all : all.filter((j) => j.status === trackerFilter);
  if (!rows.length) {
    $('#tracker').innerHTML = `<div class="empty"><h2>${all.length ? 'Nothing in this stage' : 'No applications yet'}</h2><p>${all.length ? 'Pick another stage above.' : 'When you press Apply on a job, Firstapply asks if you applied and keeps track here.'}</p>${all.length ? '' : '<a class="btn btn-primary" href="#/jobs">Find jobs</a>'}</div>`;
    return;
  }
  $('#tracker').innerHTML = `<table class="table"><thead><tr><th>Job</th><th>Status</th><th>Applied</th><th>Notes</th><th><span class="visually-hidden">Links</span></th></tr></thead><tbody>
    ${rows.map((j) => `<tr data-id="${esc(j.id)}">
      <td><div class="job-cell">${logo(j)}<div><a href="#/jobs/${encodeURIComponent(j.id)}">${esc(j.title)}</a><div class="hint">${esc(j.company)}${j.city ? `, ${esc(j.city)}` : ''}</div></div></div></td>
      <td><label class="visually-hidden" for="st-${esc(j.id)}">Status</label><select class="select status-${j.status}" id="st-${esc(j.id)}" data-status>${TRACK_STATUSES.map((s) => `<option value="${s}" ${s === j.status ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}<option value="">Remove</option></select></td>
      <td class="date">${fmtDate(j.applied_at)}</td>
      <td><input class="notes-input" data-notes value="${esc(j.notes)}" placeholder="Add a note" aria-label="Notes"></td>
      <td><a class="icon-btn" href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener noreferrer" aria-label="Open posting">${icons.external}</a></td>
    </tr>`).join('')}</tbody></table>`;
  $('#tracker').onchange = async (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    if (e.target.matches('[data-status]')) await setStatus(tr.dataset.id, e.target.value || null);
    if (e.target.matches('[data-notes]')) {
      const st = tr.querySelector('[data-status]').value;
      await api(`/api/jobs/${encodeURIComponent(tr.dataset.id)}/status`, { method: 'PUT', body: { status: st, notes: e.target.value } });
      toast('Note saved');
    }
  };
}

async function updateCounts() {
  try {
    const items = await loadTracker();
    const saved = items.filter((j) => j.status === 'saved').length;
    const applied = items.filter((j) => TRACK_STATUSES.includes(j.status)).length;
    $('#count-saved').textContent = saved || '';
    $('#count-applied').textContent = applied || '';
  } catch { /* counts are optional */ }
}

// ---------- alerts page ----------
async function renderAlerts() {
  $('#main').innerHTML = `<div class="page"><div class="page-head"><div><h1>Alerts</h1><p>Get an email with the apply link as soon as a matching job is posted.</p></div>
    <div class="head-actions"><a class="btn btn-primary" href="#/jobs">${icons.bell}New alert from a search</a></div></div>
    <div id="alerts-root"><div class="skeleton" style="height:200px"></div></div></div>`;
  const [account, alerts] = await Promise.all([api('/api/account'), api('/api/alerts')]);
  state.account = account;
  const syncLine = (s) => s.at ? `Checked ${ago(s.at)}. ${nf.format(s.fetched)} jobs read, ${nf.format(s.new)} new.` : 'Not checked yet.';

  $('#alerts-root').innerHTML = `
    <section class="panel panel-pad" aria-labelledby="email-h">
      <h2 id="email-h">Alert emails</h2>
      <p class="hint" style="margin:4px 0 0">Sent to <strong>${esc(account.email)}</strong>, the address you signed in with.</p>
      <div class="email-row">
        <label class="toggle-row"><span class="switch"><input type="checkbox" role="switch" id="emails-on" ${account.emailsPaused ? '' : 'checked'}></span>
          <span>Email me when new jobs match my alerts</span></label>
      </div>
      <div class="head-actions" style="margin-top:14px">
        <button class="btn btn-sm" type="button" id="test-email" ${account.mailReady ? '' : 'disabled'}>Send test email</button>
      </div>
      ${account.lastEmailError ? `<div class="callout callout-warn"><div><strong>The last alert email couldn't be delivered:</strong> ${esc(account.lastEmailError)}</div></div>`
        : account.lastEmailAt ? `<p class="hint" style="margin:12px 0 0">Last alert email sent ${ago(account.lastEmailAt)}.</p>` : ''}
    </section>
    <section class="panel" aria-labelledby="alerts-h">
      <div class="panel-pad" style="padding-bottom:12px"><h2 id="alerts-h">Your alerts</h2></div>
      ${alerts.length ? alerts.map((a) => `
        <div class="alert-row ${a.enabled ? '' : 'off'}" data-id="${a.id}">
          <div>
            <div class="alert-name">${esc(a.name)}</div>
            <div class="alert-summary">${esc(a.summary)}</div>
            <div class="alert-stats">${nf.format(a.matchesLastWeek)} matching ${a.matchesLastWeek === 1 ? 'job' : 'jobs'} posted in the past 7 days. ${nf.format(a.sent)} emailed so far.</div>
          </div>
          <div class="alert-controls">
            <label class="visually-hidden" for="freq-${a.id}">How often</label>
            <select class="select" id="freq-${a.id}" data-freq><option value="instant" ${a.frequency === 'instant' ? 'selected' : ''}>Instantly</option><option value="daily" ${a.frequency === 'daily' ? 'selected' : ''}>Daily</option></select>
            <button type="button" class="btn btn-sm" data-view>View jobs</button>
            <button type="button" class="btn btn-sm btn-ghost btn-danger" data-delete>Delete</button>
            <span class="switch"><input type="checkbox" role="switch" data-toggle ${a.enabled ? 'checked' : ''} aria-label="Alert on"></span>
          </div>
        </div>`).join('')
        : `<div class="empty" style="padding-top:24px"><h2>No alerts yet</h2><p>Search for the jobs you want, then press Create alert.</p></div>`}
    </section>
    ${account.admin ? `<section class="panel panel-pad" aria-labelledby="src-h">
      <h2 id="src-h">Job sources</h2>
      <p class="hint" style="margin:4px 0 0">Only you see this as the site admin. New jobs are checked every ${account.pollMinutes} minutes.${account.lastError ? ` Last error: ${esc(account.lastError.message)}` : ''}</p>
      <div class="sources">${Object.values(account.syncs ?? {}).map((s) => `<div class="source-card"><strong>${esc(s.label)}</strong><span>${syncLine(s)}</span></div>`).join('')}</div>
      <button type="button" class="btn btn-sm" id="sync-now" style="margin-top:14px">Check for new jobs now</button>
    </section>` : ''}
    <section class="panel panel-pad" aria-labelledby="account-h">
      <h2 id="account-h">Your account</h2>
      <p class="hint" style="margin:4px 0 0">Signed in as ${esc(account.email)} since ${fmtDate(account.createdAt)}.</p>
      <div class="head-actions" style="margin-top:14px">
        <a class="btn btn-sm" href="/api/account/export" download>Download my data</a>
        <button type="button" class="btn btn-sm" id="sign-out">Sign out</button>
        <button type="button" class="btn btn-sm" id="sign-out-all">Sign out on all devices</button>
        <button type="button" class="btn btn-sm btn-ghost btn-danger" id="delete-account">Delete account</button>
      </div>
    </section>`;

  $('#emails-on').onchange = async (e) => {
    try {
      await api('/api/account', { method: 'PUT', body: { emailsPaused: !e.target.checked } });
      toast(e.target.checked ? 'Alert emails on' : 'Alert emails paused');
    } catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
  };
  $('#test-email').onclick = async (e) => {
    e.target.disabled = true;
    try { const r = await api('/api/email/test', { method: 'POST' }); toast(`Test email sent to ${r.to}`); } catch (err) { toast(err.message); }
    e.target.disabled = false;
  };
  $('#sign-out').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
    location.hash = '#/jobs';
    toast('Signed out');
  };
  $('#sign-out-all').onclick = async () => {
    await api('/api/account/logout-everywhere', { method: 'POST' });
    setUser(null);
    location.hash = '#/jobs';
    toast('Signed out on all devices');
  };
  $('#delete-account').onclick = async () => {
    if (!confirm('Delete your Firstapply account? Your alerts, saved jobs and application history are erased for good, and alert emails stop. This cannot be undone.')) return;
    try {
      await api('/api/account', { method: 'DELETE' });
      setUser(null);
      location.hash = '#/jobs';
      toast('Your account was deleted');
    } catch (err) { toast(err.message); }
  };
  $('#sync-now')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Checking…';
    try {
      const r = await api('/api/sync', { method: 'POST' });
      toast(r.error ? `Check failed: ${r.error}` : r.skipped ? 'A check is already running' : `${r.new} new ${r.new === 1 ? 'job' : 'jobs'} found`);
    } catch (err) { toast(err.message); }
    renderAlerts();
  });
  $('#alerts-root').addEventListener('change', async (e) => {
    const row = e.target.closest('.alert-row');
    if (!row) return;
    const body = e.target.matches('[data-toggle]') ? { enabled: e.target.checked } : e.target.matches('[data-freq]') ? { frequency: e.target.value } : null;
    if (!body) return;
    await api(`/api/alerts/${row.dataset.id}`, { method: 'PUT', body });
    row.classList.toggle('off', body.enabled === false);
    toast(body.enabled === false ? 'Alert paused' : body.enabled ? 'Alert on' : 'Alert updated');
  });
  $('#alerts-root').addEventListener('click', async (e) => {
    const row = e.target.closest('.alert-row');
    if (!row) return;
    const alert = alerts.find((a) => String(a.id) === row.dataset.id);
    if (e.target.closest('[data-view]')) {
      state.filters = { ...DEFAULT_FILTERS, ...Object.fromEntries(LIST_KEYS.map((k) => [k, []])), ...alert.filters };
      store.set('filters', state.filters);
      syncSearchInputs();
      location.hash = '#/jobs';
    }
    if (e.target.closest('[data-delete]')) {
      if (!confirm(`Delete the alert "${alert.name}"? You won't get emails for it anymore.`)) return;
      await api(`/api/alerts/${alert.id}`, { method: 'DELETE' });
      row.remove();
      toast('Alert deleted');
    }
  });
}

// ---------- live status ----------
let lastWsjSync = null;
function renderRadar() {
  const el = $('#radar');
  if (!el || !state.settings) return;
  const at = state.settings.syncs?.wsj?.at;
  el.lastElementChild.textContent = at ? `Live, updated ${ago(at)}` : 'Starting';
  el.title = 'New jobs are checked every 5 minutes';
}

async function pollStatus() {
  try {
    const s = await api('/api/status');
    state.settings = { ...state.settings, syncs: s.syncs };
    const wsj = s.syncs.wsj;
    if (lastWsjSync && wsj?.at && wsj.at !== lastWsjSync && wsj.new > 0 && $('#list')) {
      toast(`${wsj.new} new ${wsj.new === 1 ? 'job' : 'jobs'} found`, { label: 'Show', run: () => { state.sort = 'discovered'; store.set('sort', 'discovered'); loadJobs(); } });
    }
    lastWsjSync = wsj?.at ?? lastWsjSync;
    renderRadar();
  } catch { /* server restarting */ }
}

// ---------- sign in ----------
function setUser(user, admin = false) {
  state.user = user;
  state.admin = admin;
  document.querySelectorAll('[data-owner]').forEach((el) => { el.hidden = !user; });
  $('#sign-in').hidden = !!user;
  if (user) updateCounts();
}

function openLogin({ then } = {}) {
  if (then) store.set('afterSignIn', 'alert');
  const modal = $('#modal');
  modal.innerHTML = `<form method="dialog" id="login-form" novalidate>
    <div class="modal-body">
      <h2>Sign in or create an account</h2>
      <p class="hint modal-lead">Save jobs, track your applications and get an email the moment a matching job is posted. No password: we email you a sign-in link.</p>
      <div><label class="label" for="login-email">Email address</label><input class="input" id="login-email" type="email" autocomplete="email" required maxlength="254"></div>
      <label class="check-row"><input type="checkbox" id="login-terms" required>
        <span>I agree to the <a href="/legal/terms.html" target="_blank" rel="noopener">terms of use</a> and have read the <a href="/legal/privacy.html" target="_blank" rel="noopener">privacy policy</a>.</span></label>
      <p class="login-error" id="login-error" role="alert"></p>
    </div>
    <div class="modal-foot"><button type="button" class="btn btn-ghost" id="login-cancel">Cancel</button><button class="btn btn-primary" type="submit" id="login-submit">Email me a sign-in link</button></div>
  </form>`;
  modal.showModal();
  $('#login-email').focus();
  $('#login-cancel').onclick = () => modal.close();
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#login-email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return void ($('#login-error').textContent = 'Enter a valid email address, like name@example.com.');
    if (!$('#login-terms').checked) return void ($('#login-error').textContent = 'Please accept the terms and privacy policy to continue.');
    $('#login-submit').disabled = true;
    try {
      await api('/api/auth/request', { method: 'POST', body: { email, acceptTerms: true } });
      modal.querySelector('.modal-body').innerHTML = `<h2>Check your inbox</h2>
        <p class="hint modal-lead">We sent a sign-in link to <strong>${esc(email)}</strong>. It works once and expires in 15 minutes. If it doesn't arrive, check your spam folder.</p>`;
      modal.querySelector('.modal-foot').innerHTML = '<button type="button" class="btn btn-primary" id="login-done">Done</button>';
      $('#login-done').onclick = () => modal.close();
    } catch (err) {
      $('#login-error').textContent = err.message;
      $('#login-submit').disabled = false;
    }
  };
}

function renderSignInPage(page) {
  const what = { saved: 'your saved jobs', applied: 'your applications', alerts: 'your email alerts' }[page] ?? 'this page';
  $('#main').innerHTML = `<div class="page"><div class="panel empty"><h2>Sign in to see ${what}</h2><p>Create a free account with just your email address to save jobs, track applications and get alerts.</p><button type="button" class="btn btn-primary" id="page-sign-in">Sign in or create account</button></div></div>`;
  $('#page-sign-in').onclick = () => openLogin();
}

// ---------- theme ----------
const isDark = () => document.documentElement.dataset.theme === 'dark'
  || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
const syncThemeButton = () => $('#theme-toggle').setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
$('#theme-toggle').onclick = () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* private mode */ }
  syncThemeButton();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeButton);
syncThemeButton();
$('#sign-in').onclick = () => openLogin();

// ---------- boot ----------
(async () => {
  try { const me = await api('/api/me'); setUser(me.user, me.admin); } catch { setUser(null); }
  // Coming back from the sign-in link after pressing "Create alert": reopen that dialog.
  if (state.user && store.get('afterSignIn') === 'alert' && location.hash.startsWith('#/jobs')) {
    store.set('afterSignIn', null);
    setTimeout(() => openAlertModal(), 600);
  }
  route();
  syncSearchInputs();
  pollStatus();
  setInterval(pollStatus, 30_000);
  try {
    state.facets = await api('/api/facets');
    $('#city-list').innerHTML = state.facets.cities.slice(0, 200).map((c) => `<option value="${esc(c.value)}">`).join('');
    renderFilterBar();
  } catch { /* filters fall back to empty lists */ }
})();
