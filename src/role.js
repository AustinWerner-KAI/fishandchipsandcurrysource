// Turns a job spec into a simple LinkedIn people search.
// Pure functions: read the spec, guess title, location and work type, build a boolean, build the URL.
// Everything here is a first guess for the recruiter to confirm or correct in the app.

// LinkedIn location IDs (geoUrn). Only ones seen in real LinkedIn URLs are listed here.
// Anything else is looked up in the logged-in browser at search time (see resolveGeo in linkedin.js).
export const KNOWN_GEO = {
  'united states': '103644278', 'usa': '103644278', 'us': '103644278', 'america': '103644278',
  'united kingdom': '101165590', 'uk': '101165590', 'britain': '101165590', 'england': '101165590',
  'united arab emirates': '104305776', 'uae': '104305776', 'emirates': '104305776',
  'canada': '101174742',
  'australia': '101452733',
  'india': '102713980',
  'germany': '101282230',
  'france': '105015875',
  'singapore': '102454443',
  'london': '102257491', 'greater london': '102257491',
  'new york': '105080838', 'new york city': '105080838', 'nyc': '105080838',
  'san francisco': '102277331', 'sf': '102277331', 'bay area': '102277331',
};

export const WORK_TYPES = ['onsite', 'hybrid', 'remote'];

// Working hours follow the office. Anything not listed keeps the default (Dubai).
const TIMEZONES = [
  [/new york|nyc|boston|miami|toronto|montreal|washington|philadelphia|atlanta|united states|usa\b|\bus\b|america/i, 'America/New_York'],
  [/chicago|austin|dallas|houston/i, 'America/Chicago'], [/san francisco|bay area|los angeles|seattle|vancouver|denver/i, 'America/Los_Angeles'],
  [/london|manchester|edinburgh|united kingdom|\buk\b|britain|england|dublin|ireland|lisbon|portugal/i, 'Europe/London'],
  [/berlin|frankfurt|munich|germany|paris|france|amsterdam|netherlands|zurich|zug|geneva|switzerland|madrid|barcelona|spain|milan|italy|stockholm|copenhagen|oslo|warsaw|vienna|brussels|luxembourg|prague/i, 'Europe/Berlin'],
  [/dubai|abu dhabi|uae|emirates|riyadh|saudi|doha|qatar|bahrain|manama/i, 'Asia/Dubai'],
  [/singapore|kuala lumpur|malaysia|manila|philippines/i, 'Asia/Singapore'], [/hong kong|shanghai|shenzhen|taipei|china/i, 'Asia/Hong_Kong'],
  [/tokyo|japan|seoul|korea/i, 'Asia/Tokyo'], [/bangalore|bengaluru|mumbai|delhi|hyderabad|india/i, 'Asia/Kolkata'],
  [/sydney|melbourne|australia/i, 'Australia/Sydney'], [/tel aviv|israel/i, 'Asia/Jerusalem'], [/istanbul|turkey/i, 'Europe/Istanbul'],
];
export function timezoneFor(location) {
  const hit = TIMEZONES.find(([re]) => re.test(String(location || '')));
  return hit ? hit[1] : null;
}

// Words that mean "this person is a recruiter, not a candidate".
export const DEFAULT_EXCLUDE = ['recruiter', 'talent acquisition', 'headhunter'];

// Domain words we look for in a spec. First match wins the domain group of the boolean.
const DOMAINS = [
  { words: ['crypto', 'digital asset', 'digital assets', 'blockchain', 'web3', 'defi', 'exchange', 'custody', 'stablecoin', 'tokenis', 'tokeniz'],
    boolean: ['crypto', '"digital asset"', 'blockchain', 'web3', 'fintech', 'startup'] },
  { words: ['fintech', 'payments', 'neobank'], boolean: ['fintech', 'payments'] },
  { words: ['trading', 'market making', 'market maker', 'hedge fund', 'prop trading', 'quant'], boolean: ['trading', '"market making"', 'quant'] },
];

// Hard skills a Recruiter "Skill keywords" filter can use. The key skill for a role is picked from these.
const TECH_SKILLS = [
  'azure', 'aws', 'gcp', 'google cloud', 'kubernetes', 'terraform', 'docker', 'devsecops', 'siem', 'splunk', 'iam',
  'zero trust', 'penetration testing', 'threat modeling', 'incident response', 'soc 2', 'iso 27001', 'hsm', 'mpc', 'cryptography',
  'solidity', 'rust', 'golang', 'go', 'python', 'typescript', 'java', 'c++', 'kafka', 'sql', 'snowflake', 'react', 'node',
  'aml', 'kyc', 'mica', 'vara', 'fca', 'derivatives', 'options', 'perpetuals', 'market making', 'otc', 'custody', 'tokenomics',
  'smart contracts', 'smart contract', 'zk', 'evm', 'layer 2', 'defi',
];

const SKILL_WORDS = [
  'azure', 'gcp', 'google cloud', 'terraform', 'docker', 'devsecops', 'siem', 'iam', 'zero trust', 'java', 'kafka', 'cryptography', 'mpc', 'hsm',
  'solidity', 'rust', 'golang', 'go', 'python', 'typescript', 'kubernetes', 'aws', 'react', 'node',
  'aml', 'kyc', 'mica', 'vara', 'fca', 'compliance', 'licensing', 'regulatory',
  'custody', 'derivatives', 'options', 'perpetuals', 'market making', 'liquidity', 'otc',
  'treasury', 'risk', 'audit', 'security', 'smart contract', 'smart contracts', 'zk', 'evm', 'layer 2', 'l2',
  'sales', 'business development', 'partnerships', 'institutional', 'growth', 'marketing', 'product', 'tokenomics',
  'listings', 'ecosystem', 'devrel', 'developer relations', 'community',
];

// Two-word phrases that stay together when a title is split into modifier + core ("Smart Contract Engineer").
const COMPOUNDS = ['smart contract', 'business development', 'market making', 'digital asset', 'data science', 'machine learning',
  'product marketing', 'talent acquisition', 'customer success', 'quality assurance', 'site reliability', 'information security',
  'cyber security', 'software engineer', 'data engineer', 'security engineer', 'product manager', 'account executive', 'sales engineer',
  'solutions engineer', 'research scientist', 'quant researcher', 'quantitative researcher', 'front end', 'back end', 'full stack'];
const SENIORITY_PREFIX = /^(senior|lead|principal|staff|junior)\s+/i;

const SENIORITY = /\b(chief|cxo|ceo|cto|cfo|coo|cco|cmo|ciso|cro|head of|head|vp|vice president|svp|evp|director|senior|lead|principal|staff|manager|associate|analyst|junior|intern)\b/i;

function clean(s) { return String(s || '').replace(/\s+/g, ' ').replace(/[–—]/g, '-').trim(); }
function lines(text) { return String(text || '').split(/\r?\n/).map(clean).filter(Boolean); }

export function guessTitle(text) {
  const ls = lines(text);
  // 1. an explicit label
  for (const l of ls) {
    const m = l.match(/^(?:job title|title|role|position)\s*[:\-]\s*(.{3,80})$/i);
    if (m) return clean(m[1]);
  }
  // 2. first short line that looks like a title
  for (const l of ls.slice(0, 12)) {
    if (l.length <= 70 && SENIORITY.test(l) && !/[.:]$/.test(l) && l.split(' ').length <= 9) {
      return l.replace(/\s*[\(\[].*$/, '').replace(/\s*[-|,]\s*(remote|hybrid|onsite|on-site|dubai|london|new york|singapore).*$/i, '').trim();
    }
  }
  // 3. "looking for a X" / "hiring a X"
  const m = String(text).match(/\b(?:looking for|hiring|seeking|appoint(?:ing)?)\s+(?:an?|the)\s+([A-Z][^.,\n]{3,60})/);
  if (m) return clean(m[1]);
  return ls[0] ? ls[0].slice(0, 70) : '';
}

export function guessLocation(text) {
  const ls = lines(text);
  for (const l of ls) {
    const m = l.match(/^(?:location|based|based in|office|city)\s*[:\-]\s*(.{2,60})$/i);
    if (m) return clean(m[1]).replace(/\s*\((remote|hybrid|onsite|on-site)\)\s*$/i, '');
  }
  const m = String(text).match(/\b(?:based in|located in|office in|relocat(?:e|ion) to|position in)\s+([A-Z][\w .'-]{2,40}?)(?=[.,;\n)]|\s+(?:and|or|with|for|the)\b)/);
  if (m) return clean(m[1]);
  const low = String(text).toLowerCase();
  const hit = Object.keys(KNOWN_GEO).filter(k => k.length > 3).sort((a, b) => b.length - a.length).find(k => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(low));
  return hit ? hit.replace(/\b\w/g, c => c.toUpperCase()) : '';
}

export function guessWorkType(text) {
  const t = String(text).toLowerCase();
  if (/\b(fully|100%)\s+remote\b|\bremote[- ]first\b|\bremote\b(?!\s*(?:work|working)?\s*(?:is not|not|no))/.test(t) && !/\bhybrid\b/.test(t)) return 'remote';
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  if (/\bon[- ]?site\b|\bin[- ]office\b|\boffice[- ]based\b|\brelocat/.test(t)) return 'onsite';
  return guessLocation(text) ? 'onsite' : 'remote';
}

const countOf = (t, w) => (t.match(new RegExp(`(^|[^a-z0-9+])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9+])`, 'g')) || []).length;
const SKILL_LABEL = { aws: 'AWS', gcp: 'GCP', iam: 'IAM', siem: 'SIEM', aml: 'AML', kyc: 'KYC', mica: 'MiCA', vara: 'VARA', fca: 'FCA', otc: 'OTC', zk: 'ZK', evm: 'EVM', mpc: 'MPC', hsm: 'HSM', sql: 'SQL', defi: 'DeFi', devsecops: 'DevSecOps', 'soc 2': 'SOC 2', 'iso 27001': 'ISO 27001' };
const labelSkill = w => SKILL_LABEL[w] || w.replace(/\b[a-z]/g, c => c.toUpperCase());

// The one skill that matters most in the spec (e.g. "Azure"), for Recruiter's Skill keywords filter.
// Only hard skills count, never words already in the title, and a skill in the title line or
// the requirements counts double.
export function keySkill(text, title = '') {
  const t = String(text || '').toLowerCase();
  const inTitle = String(title).toLowerCase();
  const head = t.split('\n').slice(0, 3).join(' ');
  const req = (t.match(/(requirements?|must have|what you.ll bring|you have|qualifications?)[\s\S]{0,1500}/) || [''])[0];
  let best = null;
  for (const w of TECH_SKILLS) {
    if (countOf(inTitle, w)) continue;
    const n = countOf(t, w) + countOf(head, w) + countOf(req, w);
    const at = t.indexOf(w);                 // on a tie, the one the spec mentions first
    if (n && (!best || n > best.n || (n === best.n && at < best.at))) best = { w, n, at };
  }
  return best ? labelSkill(best.w) : '';
}

export function guessDomain(text) {
  const t = String(text).toLowerCase();
  return DOMAINS.find(d => d.words.some(w => t.includes(w))) || null;
}

export function guessSkills(text, max = 4) {
  const t = String(text).toLowerCase();
  const counts = [];
  for (const w of SKILL_WORDS) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const n = (t.match(re) || []).length;
    if (n) counts.push({ w, n });
  }
  // longer phrases first on ties so "smart contracts" beats "go"
  counts.sort((a, b) => b.n - a.n || b.w.length - a.w.length);
  const out = [];
  for (const { w } of counts) {
    if (out.some(o => o.includes(w) || w.includes(o))) continue;
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

// "Senior Cloud Security Engineer" -> { seniority: 'Senior', modifiers: ['Cloud'], core: 'Security Engineer' }
// The core is the last two words (or a known compound plus its noun); anything in front is a modifier
// that becomes its own AND term, so the search also catches "Security Engineer, Cloud Platform".
export function splitTitle(title) {
  let t = clean(title);
  const sm = t.match(SENIORITY_PREFIX);
  const seniority = sm ? sm[1] : '';
  if (sm) t = t.slice(sm[0].length);
  const words = t.split(' ');
  if (words.length <= 2 || /^(head|director|vp|chief|vice)\b/i.test(t) || /\bof\b/i.test(t)) return { seniority, modifiers: [], core: t };
  const low = words.map(w => w.toLowerCase());
  // core = last 2 words, or last 3 if the last two form a compound noun ("Smart Contract" + Engineer)
  const coreLen = COMPOUNDS.includes(low.slice(-3, -1).join(' ')) ? 3 : 2;
  return { seniority, modifiers: words.slice(0, -coreLen), core: words.slice(-coreLen).join(' ') };
}

// "Head of Compliance" -> ["Head of Compliance", "Compliance Director", "VP Compliance", "Compliance Lead"]
// "Senior Cloud Security Engineer" -> ["Security Engineer", "Senior Security Engineer", "Lead Security Engineer", "Principal Security Engineer"]
export function titleVariants(title) {
  const t = clean(title);
  if (!t) return [];
  const split = splitTitle(t);
  if (split.modifiers.length || split.seniority) { const c = split.core; return [c, `Senior ${c}`, `Lead ${c}`, `Principal ${c}`]; }
  const out = new Set([t]);
  let m;
  if ((m = t.match(/^head of (.+)$/i))) { const x = m[1]; out.add(`${x} Director`); out.add(`Director of ${x}`); out.add(`VP ${x}`); out.add(`${x} Lead`); }
  else if ((m = t.match(/^(?:vp|vice president)(?: of)? (.+)$/i))) { const x = m[1]; out.add(`Head of ${x}`); out.add(`${x} Director`); out.add(`SVP ${x}`); }
  else if ((m = t.match(/^director of (.+)$/i)) || (m = t.match(/^(.+) director$/i))) { const x = m[1]; out.add(`Head of ${x}`); out.add(`Director of ${x}`); out.add(`${x} Director`); out.add(`VP ${x}`); }
  else if ((m = t.match(/^chief (.+) officer$/i))) { const x = m[1]; out.add(`Head of ${x}`); out.add(`VP ${x}`); out.add(`${x} Director`); }
  else if ((m = t.match(/^(.+) (engineer|developer)$/i))) { const x = m[1]; out.add(`${x} Engineer`); out.add(`${x} Developer`); out.add(`Senior ${x} Engineer`); }
  else if ((m = t.match(/^(.+) manager$/i))) { const x = m[1]; out.add(`${x} Lead`); out.add(`Head of ${x}`); }
  return [...out].map(clean).filter((v, i, a) => a.findIndex(o => o.toLowerCase() === v.toLowerCase()) === i).slice(0, 5);
}

function quote(s) { s = clean(s).replace(/"/g, ''); return /\s/.test(s) ? `"${s}"` : s; }
function group(items) { const q = items.map(quote).filter(Boolean); return q.length > 1 ? `(${q.join(' OR ')})` : q[0] || ''; }

// Keeps it simple on purpose: [must AND must] AND (titles) AND (industry) NOT (recruiters).
// "skills" are must-haves: each one is its own AND term.
export function buildBoolean({ titles = [], domain = [], skills = [], exclude = DEFAULT_EXCLUDE } = {}) {
  const parts = [...skills.map(quote).filter(Boolean), group(titles), group(domain)].filter(Boolean);
  let b = parts.join(' AND ');
  const ex = exclude.map(quote).filter(Boolean);
  if (b && ex.length) b += ' NOT ' + (ex.length > 1 ? `(${ex.join(' OR ')})` : ex[0]);
  return b;
}

export function buildSearchUrl(boolean, geoUrns = []) {
  const u = new URL('https://www.linkedin.com/search/results/people/');
  u.searchParams.set('keywords', boolean);
  const ids = geoUrns.filter(Boolean);
  if (ids.length) u.searchParams.set('geoUrn', JSON.stringify(ids));
  u.searchParams.set('origin', 'FACETED_SEARCH');
  return u.toString();
}

// Exact match only ("UAE"). With loose: "Dubai, UAE" also matches on its country part, which is
// the right fallback when LinkedIn could not be asked for the city itself.
export function lookupGeo(name, { loose = false } = {}) {
  const k = clean(name).toLowerCase().replace(/^the /, '');
  if (!k) return null;
  if (KNOWN_GEO[k]) return KNOWN_GEO[k];
  if (loose) for (const part of k.split(',').map(s => s.trim())) if (KNOWN_GEO[part]) return KNOWN_GEO[part];
  return null;
}

export function slugFor(title, location) {
  return `${title} ${location || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34).replace(/-+$/, '') || 'role';
}

// Reads a whole spec and returns the first draft of everything the wizard shows.
export function draftRole(text) {
  const title = guessTitle(text);
  const location = guessLocation(text);
  const workType = guessWorkType(text);
  const domain = guessDomain(text);
  const skills = guessSkills(text);
  const titles = titleVariants(title);
  const required = splitTitle(title).modifiers;      // "Cloud" from "Senior Cloud Security Engineer"
  const key = keySkill(text, title);
  return {
    recruiterSkills: key ? [key] : [],
    title, location, workType,
    // remote roles: where the candidate may sit. Starts equal to the office location; the recruiter widens it.
    candidateLocations: location ? [location] : [],
    titles,
    domain: domain ? domain.boolean : [],
    required,
    skills,
    exclude: [...DEFAULT_EXCLUDE],
    boolean: buildBoolean({ titles, domain: domain ? domain.boolean : [], skills: required, exclude: DEFAULT_EXCLUDE }),
  };
}

// Reads a .txt, .pdf or .docx into plain text.
export async function extractText(filename, buffer) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try { return (await parser.getText()).text || ''; } finally { await parser.destroy(); }
  }
  if (ext === 'docx') {
    const mammoth = await import('mammoth');
    const r = await mammoth.extractRawText({ buffer });
    return r.value || '';
  }
  return buffer.toString('utf8');
}

// When LinkedIn returns nothing, loosen the boolean one step at a time:
// drop the NOT group, then the trailing AND groups, then all but the first title.
export function widenBoolean(boolean) {
  const b = String(boolean || '').trim();
  const out = [];
  let cur = b.replace(/\s+NOT\s+(\([^)]*\)|"[^"]*"|\S+)\s*$/i, '').trim();
  if (cur && cur !== b) out.push({ step: 'without the exclude words', boolean: cur });
  let m;
  while ((m = cur.match(/^(.*\S)\s+AND\s+(\([^)]*\)|"[^"]*"|\S+)\s*$/))) {
    cur = m[1].trim();
    out.push({ step: 'without the last AND group', boolean: cur });
  }
  const first = cur.match(/^\(\s*("[^"]*"|\S+)\s+OR\s/);
  if (first) out.push({ step: 'first title only', boolean: first[1] });
  return out;
}
