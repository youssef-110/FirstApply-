// Shared helpers that make jobs from different sources comparable.

const CITY_ALIASES = {
  'münchen': 'Munich', 'muenchen': 'Munich',
  'köln': 'Cologne', 'koeln': 'Cologne',
  'nürnberg': 'Nuremberg', 'nuernberg': 'Nuremberg',
  'hannover': 'Hanover',
  'frankfurt am main': 'Frankfurt', 'frankfurt (main)': 'Frankfurt', 'frankfurt/main': 'Frankfurt',
  'braunschweig': 'Brunswick',
};

export const normalizeCity = (raw) => {
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, ' ').trim();
  return CITY_ALIASES[clean.toLowerCase()] ?? clean;
};

const GENDER_TAG = /\((?:[mwfdx]\s*[/|,]\s*){1,3}[mwfdx]\)|\(all genders?\)|\(gn\)|\*in\b|:in\b/gi;

export const cleanTitle = (title) => title.replace(GENDER_TAG, '').replace(/\s{2,}/g, ' ').trim();

const keyPart = (s) => (s || '')
  .toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(GENDER_TAG, '')
  .replace(/\b(gmbh|ag|se|kg|co|mbh|inc|ltd|e\.?v)\b/g, '')
  .replace(/[^a-z0-9]+/g, '');

export const dedupeKey = (company, title, city) => `${keyPart(company)}|${keyPart(title)}|${keyPart(city)}`;

// Title/occupation keyword → tech sub field, in priority order.
const TECH_RULES = [
  ['cybersecurity', /cyber|\bit.?security|information security|informationssicherheit|\bit-sicherheit|security (engineer|analyst|operations)|pentest|\bsoc\b/],
  ['ai-ml', /machine learning|\bml\b|\bki\b|\bai\b|artificial intelligence|künstliche intelligenz|data scien|deep learning|\bllm|computer vision|\bnlp\b/],
  ['data-engineering', /data engineer|daten.?engineer|\betl\b|data platform/],
  ['data-analytics', /data analy|datenanaly|data analytics|business intelligence|\bbi\b|power bi|tableau/],
  ['cloud-devops', /devops|cloud (infra|engineer|platform|architect)|kubernetes|\baws\b|\bgcp\b|platform engineer|\bsre\b|site reliability/],
  ['qa-testing', /\bqa\b|quality assurance|testautomat|test automation|softwaretest|software test|qa engineer/],
  ['embedded-systems', /embedded|firmware|eingebettet|fpga|mikrocontroller|microcontroller/],
  ['sap-erp', /\bsap\b|\berp\b/],
  ['product-management', /product (owner|manag)|produktmanag/],
  ['it-support', /\bit.?support|helpdesk|service ?desk|\bit-?administrat|system.?administrat|netzwerk.?administrat|\bit-?service|client management|1st level|2nd level|\bit-?infrastruktur/],
  ['software-engineering', /software|developer|softwareentwickl|anwendungsentwickl|web.?entwickl|app.?entwickl|programmier|frontend|backend|full.?stack|web.?develop|informatik|\bjava\b|python|typescript|\.net\b|\breact\b/],
];

const FIELD_RULES = [
  ['hr', /personal|human resources|\bhr\b|recruit|people/],
  ['marketing', /marketing|social media|content|kommunikation|communication|seo|brand/],
  ['sales', /vertrieb|sales|business development|account|key account/],
  ['finance', /finan|controlling|buchhalt|accounting|steuer|tax|audit|treasury|bank/],
  ['legal', /recht|legal|jurist|compliance/],
  ['logistics', /logistik|logistics|supply chain|einkauf|procurement|lager/],
  ['design', /design|ux|ui\b|grafik/],
  ['consulting', /consult|beratung/],
  ['research', /forschung|research|wissenschaft/],
  ['healthcare', /pflege|medizin|health|klinik|pharma/],
  ['engineering', /ingenieur|engineering|maschinenbau|elektrotechnik|mechan|konstruktion|bau|energie|technik/],
  ['operations', /operations|projekt|project|office|verwaltung|assistenz|assistant|organisation/],
];

// Texts are tried in order (title first): the BA occupation code is often a poor guess,
// so it only decides when the title itself says nothing.
export const classifyField = (...texts) => {
  for (const text of texts.filter(Boolean)) {
    const hay = text.toLowerCase();
    for (const [sub, re] of TECH_RULES) if (re.test(hay)) return { field: 'tech', sub_field: sub };
    for (const [field, re] of FIELD_RULES) if (re.test(hay)) return { field, sub_field: null };
  }
  return { field: 'other', sub_field: null };
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const fetchJson = async (url, headers = {}, attempt = 1) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'JobRadar/0.1 (personal job alert tool)', Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(30_000),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(2000 * attempt);
    return fetchJson(url, headers, attempt + 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
};
