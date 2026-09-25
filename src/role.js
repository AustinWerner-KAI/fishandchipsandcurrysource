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
// Only other recruiters are excluded in the search itself. Interns and juniors are held back
// locally instead: LinkedIn's NOT matches anywhere on a profile, so excluding "intern" here
// would also lose a senior person who still lists the internship they did ten years ago.
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
  'llm', 'grpc', 'linux', 'kotlin', 'scala', 'c#', '.net', 'javascript',
];
// Concepts ("distributed systems") are skills to look for, never the key skill: Recruiter's Skills
// filter needs a concrete tool or language (24 Sep 2026: the Palantir link made "Distributed Systems" key).

const SKILL_WORDS = [
  'azure', 'gcp', 'google cloud', 'terraform', 'docker', 'devsecops', 'siem', 'iam', 'zero trust', 'java', 'kafka', 'cryptography', 'mpc', 'hsm',
  'solidity', 'rust', 'golang', 'go', 'python', 'typescript', 'kubernetes', 'aws', 'react', 'node',
  'aml', 'kyc', 'mica', 'vara', 'fca', 'compliance', 'licensing', 'regulatory',
  'custody', 'derivatives', 'options', 'perpetuals', 'market making', 'liquidity', 'otc',
  'treasury', 'risk', 'audit', 'security', 'smart contract', 'smart contracts', 'zk', 'evm', 'layer 2', 'l2',
  'sales', 'business development', 'partnerships', 'institutional', 'growth', 'marketing', 'product', 'tokenomics',
  'listings', 'ecosystem', 'devrel', 'developer relations', 'community',
  'distributed systems', 'microservices', 'apis', 'api design', 'observability', 'infrastructure', 'containers', 'grpc', 'linux',
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
  return titleCandidates(text)[0]?.title || '';
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
const SKILL_LABEL = { llm: 'LLM', aws: 'AWS', gcp: 'GCP', iam: 'IAM', siem: 'SIEM', aml: 'AML', kyc: 'KYC', mica: 'MiCA', vara: 'VARA', fca: 'FCA', otc: 'OTC', zk: 'ZK', evm: 'EVM', mpc: 'MPC', hsm: 'HSM', sql: 'SQL', defi: 'DeFi', devsecops: 'DevSecOps', 'soc 2': 'SOC 2', 'iso 27001': 'ISO 27001' };
const labelSkill = w => SKILL_LABEL[w] || w.replace(/\b[a-z]/g, c => c.toUpperCase());

// The one skill that matters most in the spec (e.g. "Azure"), for Recruiter's Skill keywords filter.
// Only hard skills count, never words already in the title, and a skill in the title line or
// the requirements counts double.
// "Go" is also an English word ("go live", "on the go"): only the capitalised Go or Golang counts.
// Another name for a skill counts for it ("K8s" is Kubernetes). 24 Sep 2026, from the Palantir link.
const SAME_AS = { llm: ['llms', 'large language model', 'large language models'], kubernetes: ['k8s'], golang: [], 'google cloud': ['gcp'] };
function mentionsOf(lowText, rawText, w) {
  if (w === 'go') return (String(rawText).match(/(^|[^A-Za-z0-9+])Go(?![A-Za-z0-9+])/g) || []).length;
  return countOf(lowText, w) + (SAME_AS[w] || []).reduce((a, x) => a + countOf(lowText, x), 0);
}
export function keySkill(text, title = '') {
  const raw = String(text || '');
  const t = raw.toLowerCase();
  const inTitle = String(title).toLowerCase();
  const rawHead = raw.split('\n').slice(0, 3).join(' ');
  const rawReq = (raw.match(/(requirements?|must have|what you.ll bring|you have|qualifications?|what we require)[\s\S]{0,1500}/i) || [''])[0];
  let best = null;
  for (const w of TECH_SKILLS) {
    if (countOf(inTitle, w)) continue;
    const n = mentionsOf(t, raw, w) + mentionsOf(rawHead.toLowerCase(), rawHead, w) + mentionsOf(rawReq.toLowerCase(), rawReq, w);
    const at = t.indexOf(w);                 // on a tie, the one the spec mentions first
    if (n && (!best || n > best.n || (n === best.n && at < best.at))) best = { w, n, at };
  }
  return best ? labelSkill(best.w) : '';
}

export function guessDomain(text) {
  const t = String(text).toLowerCase();
  return DOMAINS.find(d => d.words.some(w => mentions(t, w))) || null;
}

// Commercial words that are skills for a BD or community role, and noise for an engineering one
// ("ecosystem" came out as a Palantir platform engineer's second skill, 24 Sep 2026).
const COMMERCIAL_WORDS = new Set(['ecosystem', 'community', 'growth', 'sales', 'marketing', 'partnerships', 'listings', 'institutional', 'business development', 'product', 'devrel', 'developer relations', 'liquidity']);
export function guessSkills(text, max = 4, { family = '', learned = [], dropped = [] } = {}) {
  const t = String(text).toLowerCase();
  const counts = [];
  const words = [...new Set([...SKILL_WORDS, ...learned.map(w => String(w).toLowerCase())])]
    .filter(w => !dropped.includes(w) && !(family === 'engineering' && COMMERCIAL_WORDS.has(w)));
  for (const w of words) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const n = (t.match(re) || []).length;
    if (n) counts.push({ w, n });
  }
  // a skill Kai taught it comes first when the spec mentions it; then the most mentioned; longer
  // phrases first on ties so "smart contracts" beats "go"
  const taught = new Set(learned.map(w => String(w).toLowerCase()));
  counts.sort((a, b) => (taught.has(b.w) - taught.has(a.w)) || b.n - a.n || b.w.length - a.w.length);
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
  if (/\s(?:&|and|\/)\s/i.test(t)) return { seniority, modifiers: [], core: t };
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
  const joint = t.match(/^(.*?)\s+(?:&|and|\/)\s+(.+?)\s+(engineer|developer|scientist)$/i);
  if (joint) return [...new Set([t, `${joint[1]} ${joint[3]}`, `${joint[2]} ${joint[3]}`])];
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

function quote(s) { s = clean(s).replace(/"/g, ''); if (!/[\p{L}\p{N}]/u.test(s) || /^(and|or|not)$/i.test(s)) return ''; return /\s/.test(s) ? `"${s}"` : s; }
function group(items) { const q = items.map(quote).filter(Boolean); return q.length > 1 ? `(${q.join(' OR ')})` : q[0] || ''; }

// Keeps it simple on purpose: [must AND must] AND (titles) AND (industry) NOT (recruiters).
// "skills" are must-haves: each one is its own AND term.
export function buildBoolean({ titles = [], domain = [], skills = [], anyOf = [], exclude = DEFAULT_EXCLUDE } = {}) {
  const parts = [...skills.map(quote).filter(Boolean), group(titles), ...anyOf.map(group), group(domain)].filter(Boolean);
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
// `known` is what a job link said for certain (title, location, work type, company); `vocab` is what
// Kai's corrections taught (see rolelearn.js).
export function draftRole(text, known = {}, vocab = {}) {
  const found = titleCandidates(text);
  const fromLink = known.title ? splitTeam(known.title) : null;
  const title = fromLink ? fromLink.title : (found[0]?.title || '');
  const team = fromLink ? fromLink.team : (found[0]?.team || '');
  const family = familyOf(title, text);
  const location = known.location || guessLocation(text);
  const workType = WORK_TYPES.includes(known.workType) ? known.workType : guessWorkType(text);
  const domain = guessDomain(text);
  const skills = guessSkills(text, 4, { family, learned: vocab.learned || [], dropped: vocab.dropped || [] });
  const titles = relatedTitles(title, text, titleVariants(title));
  const required = splitTitle(title).modifiers;      // "Cloud" from "Senior Cloud Security Engineer"
  const key = keySkill(text, title);
  // An engineering title with nothing in front of it ("Software Engineer") is far too wide on its own,
  // so the key skill joins Search 1. Every other kind of role keeps Kai's pattern exactly.
  const modelSystems = specHints(text).modelSystems || [];
  const anyOf = modelSystems.length ? [modelSystems] : genericTitle(title) && key ? [withAliases(key)] : [];
  const exclude = [...DEFAULT_EXCLUDE];
  const domainBool = []; // Sector is an optional recruiter refinement, never a default hard filter.
  const titleOptions = [...new Set([title, ...found.map(f => f.title), ...titles.filter(t => !SENIORITY_PREFIX.test(t))].filter(Boolean))].slice(0, 3);
  return {
    recruiterSkills: modelSystems.length ? [] : key ? [key] : [],
    title, location, workType, team, family, titleOptions,
    company: known.company || '',
    // remote roles: where the candidate may sit. Starts equal to the office location; the recruiter widens it.
    candidateLocations: location ? [location] : [],
    titles,
    domain: domainBool,
    suggestedDomain: domain?.boolean || [],
    required,
    skills,
    exclude,
    boolean: buildBoolean({ titles, domain: domainBool, skills: required, anyOf, exclude }),
    boolean2: buildSkillsBoolean({ key, required, family, domain: domainBool, text, title, exclude }),
    specHints: specHints(text),
    titleGuessed: !fromLink && !!found[0]?.guessed,
  };
}

// ---- reading the title (24 Sep 2026) ----------------------------------------------------------
// The old reader took the first short line with a SENIORITY word in it, so "Software Engineer"
// (no such word) fell through to the spec's first line: "New York, NY" became the title. Now a
// title has to contain a job word, and lines that are plainly places, pay or work type are skipped.
// Job words as titles use them: singular. The plural is prose ("backed by leading venture partners",
// "founded by ex-Goldman traders and engineers"), which the first version of this took for titles.
export const JOB_WORD = /\b(engineer|developer|programmer|architect|scientist|analyst|manager|director|head|lead|chief|officer|cto|ceo|cfo|coo|cco|cmo|ciso|cro|mlro|vp|svp|evp|vice president|president|designer|researcher|specialist|consultant|associate|executive|administrator|coordinator|recruiter|counsel|lawyer|attorney|accountant|controller|trader|strategist|partner|founder|sre|devops|intern|representative|advisor|adviser|economist|auditor|writer|editor|marketer|evangelist|advocate|owner|principal|staff)\b/i;
// A line that is only work type, commitment, pay, a link or a section heading is not a title;
// "Remote Operations Manager" and "Contract Manager" are.
const NOT_A_TITLE = /^(https?:|www\.)|\$\s?\d|\b(salary|per annum|a year|per year|apply now)\b|^(about (us|the (company|role|team))|the role|responsibilities|requirements|benefits|what we (value|require|offer)|who you are)\s*:?$|^((full|part)[- ]time|contract|permanent|remote|hybrid|on[- ]?site)(\s*[\/|,·-]\s*((full|part)[- ]time|contract|permanent|remote|hybrid|on[- ]?site))*$/i;
// A sentence, not a title: company blurbs sit at the top of many specs.
const PROSE = /\b(by|with|from|our|we|you|your|is|are|was|were|backed|founded|leading|world'?s?|join|help|build(ing)?|who|that|which|will|we're|you'll)\b/i;
// A rank on its own is not a job ("VP, Engineering" is not "VP"): such a title is kept whole.
const RANK_ONLY = /^((senior|junior|group|associate|assistant|deputy)\s+)?(vp|svp|evp|vice president|director|head|manager|lead|principal|chief|officer|partner|associate|analyst|president|managing director|md|staff)$/i;
// Places with no LinkedIn id listed above, so they are only recognised, never searched by id.
const MORE_PLACES = ['dubai', 'abu dhabi', 'zug', 'zurich', 'geneva', 'berlin', 'munich', 'paris', 'amsterdam', 'lisbon', 'madrid', 'barcelona', 'dublin', 'hong kong', 'tokyo', 'seoul', 'sydney', 'melbourne', 'toronto', 'vancouver', 'chicago', 'boston', 'austin', 'miami', 'seattle', 'los angeles', 'denver', 'bangalore', 'bengaluru', 'riyadh', 'doha', 'bahrain', 'cayman islands', 'bermuda', 'hk', 'ksa'];
// "New York, NY", "London", "UAE": a known place, or place words with at most a two-letter code
// beside them. A two-letter word on its own ("Go") is not a place.
export function isPlace(l) {
  const x = String(l).toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!x) return false;
  const keys = [...Object.keys(KNOWN_GEO), ...MORE_PLACES];
  if (keys.includes(x)) return true;
  const words = x.split(' ');
  const placeWord = w => w.length > 2 && keys.some(k => k.split(' ').includes(w));
  return words.some(placeWord) && words.every(w => placeWord(w) || /^[a-z]{2}$/.test(w));
}

// "Software Engineer - Environment Platform" -> { title: 'Software Engineer', team: 'Environment Platform' }
// Lever and Greenhouse write titles as "Role - Team"; the team is a hint, never searched as a title.
export function splitTeam(raw) {
  const t = clean(raw);
  const parts = t.split(/\s+[-|:]\s+|\s*,\s+(?=[A-Z])|\s+\((?=[^)]*\)$)/).map(x => x.replace(/\)$/, '').trim()).filter(Boolean);
  if (parts.length < 2) return { title: t, team: '' };
  const withJob = parts.filter(p => JOB_WORD.test(p));
  if (withJob.length !== 1) return { title: t, team: '' };       // both halves look like titles: keep it whole
  if (RANK_ONLY.test(withJob[0])) return { title: t, team: '' };  // "VP, Engineering", "Senior Manager, Risk"
  return { title: withJob[0], team: parts.filter(p => p !== withJob[0]).join(' · ') };
}

// Up to three guesses, best first, each with why it was picked.
export function titleCandidates(text) {
  const ls = lines(text);
  const out = [];
  const add = (raw, score, why) => {
    const { title, team } = splitTeam(String(raw).replace(/\s*[\(\[].*$/, '').replace(/\s*[|,]\s*(remote|hybrid|onsite|on-site)\b.*$/i, ''));
    if (!title || !JOB_WORD.test(title) || isPlace(title) || NOT_A_TITLE.test(title) || title.split(' ').length > 9) return;
    if (why !== 'the spec labels it' && PROSE.test(title)) return;
    if (!out.some(o => o.title.toLowerCase() === title.toLowerCase())) out.push({ title, team, score, why });
  };
  // 1. an explicit label
  for (const l of ls) { const m = l.match(/^(?:job title|title|role|position)\s*[:\-]\s*(.{3,80})$/i); if (m) add(m[1], 100, 'the spec labels it'); }
  // 2. a short line near the top that is a job title
  ls.slice(0, 15).forEach((l, i) => { if (l.length <= 80 && !/[.:;!?]$/.test(l) && !/^(?:job title|title|role|position)\s*[:\-]/i.test(l)) add(l, 80 - i, i === 0 ? 'the first line' : 'a title line near the top'); });
  // 3. "looking for a X" / "join us as a X" / "as a X, you"
  for (const m of String(text).matchAll(/\b(?:looking for|hiring|seeking|appoint(?:ing)?|join (?:us|our team|the team) as|as)\s+(?:an?|the|our)\s+([A-Z][^.,\n]{3,60})/g)) add(m[1], 60, 'the spec says who it is looking for');
  // 4. nothing named it: say what the spec reads like, as a clearly weaker guess
  if (!out.length) { const f = familyOf('', text); if (FAMILY_TITLE[f]) out.push({ title: FAMILY_TITLE[f], team: '', score: 20, why: `the spec reads like ${FAMILY_WORD[f]}`, guessed: true }); }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

// ---- what kind of role it is -------------------------------------------------------------------
const FAMILY_SIGNS = {
  engineering: /\b(software development|software engineer|coding|code review|kubernetes|k8s|microservices|distributed systems|apis?|backend|back-end|frontend|front-end|full[- ]stack|golang|java|python|typescript|rust|c\+\+|compilers?|system design|infrastructure)\b/g,
  security: /\b(security|iam|siem|threat|vulnerabilit|penetration|incident response|zero trust|soc ?2|iso 27001|devsecops)\w*/g,
  compliance: /\b(compliance|aml|kyc|regulat|licens|mica|vara|fca|sanctions|mlro)\w*/g,
  sales: /\b(sales|business development|revenue|quota|pipeline|clients?|accounts?|partnerships|deal)\w*/g,
};
const FAMILY_TITLE = { engineering: 'Software Engineer', security: 'Security Engineer', compliance: 'Compliance Manager', sales: 'Business Development Manager' };
export const FAMILY_WORD = { engineering: 'software engineering', security: 'security', compliance: 'compliance', sales: 'sales or business development', devrel: 'developer relations' };
// Security engineers are engineers too; the title decides first, the spec only when the title is silent.
export function familyOf(title, text = '') {
  const t = String(title).toLowerCase();
  if (/\b(developer relations|devrel|developer advocate|evangelist|community)\b/.test(t)) return 'devrel';
  if (/\b(sales|business develop\w*|account (executive|manager)|partnerships?|solutions (architect|engineer)|pre-?sales|go[- ]to[- ]market)\b/.test(t)) return 'sales';
  if (/\b(security|iam|ciso)\b/.test(t)) return 'security';
  if (/\b(engineer|developer|programmer|sre|devops|architect)\b/.test(t)) return 'engineering';
  if (/\b(compliance|aml|kyc|mlro|regulatory)\b/.test(t)) return 'compliance';
  if (/\b(sales|business development|account executive|partnerships)\b/.test(t)) return 'sales';
  const low = String(text).toLowerCase();
  const n = Object.fromEntries(Object.entries(FAMILY_SIGNS).map(([f, re]) => [f, (low.match(re) || []).length]));
  const [best, count] = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return count >= 3 ? best : '';
}

// "Software Engineer" says nothing about the work; "Rust Engineer" or "Cloud Security Engineer" does.
// Only a generic title is widened: titled roles keep exactly the search Kai's pattern gives them.
export const genericTitle = t => /^(?:(?:senior|lead|principal|staff|junior)\s+)?(?:(?:software|backend|back-end|platform|infrastructure|full[- ]stack|systems?|application)\s+)?(?:engineer|developer)$/i.test(clean(t));

// A generic engineering title gets its near neighbours, picked by what the spec is about.
export function relatedTitles(title, text, base = []) {
  const out = [...base];
  if (!genericTitle(title)) return out;
  const low = String(text).toLowerCase();
  const add = t => { if (!out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t); };
  if (/\b(kubernetes|k8s|platform|infrastructure|containers?|devops)\b/.test(low)) { add('Platform Engineer'); add('Infrastructure Engineer'); }
  if (/\b(backend|back-end|apis?|microservices|distributed systems)\b/.test(low)) add('Backend Engineer');
  if (/\b(frontend|front-end|react|typescript)\b/.test(low)) add('Frontend Engineer');
  if (/\b(data pipelines?|etl|spark|airflow)\b/.test(low)) add('Data Engineer');
  // the seniority copies of a generic title are dropped first when there is not room for all
  const plain = out.filter(t => !SENIORITY_PREFIX.test(t) && !/developer$/i.test(t));
  return [...new Set([...plain.slice(0, 1), ...out.filter(t => /^senior /i.test(t)).slice(0, 1), ...plain.slice(1)])].slice(0, 5);
}

// Kubernetes is also written K8s, Go also Golang: both go in the same OR group.
const ALIASES = { kubernetes: ['K8s'], go: ['Golang'], golang: ['Go'], javascript: ['JS'], typescript: ['TS'], 'google cloud': ['GCP'], gcp: ['Google Cloud'], 'smart contracts': ['Solidity'], iam: ['"Identity and Access Management"'] };
export function withAliases(skill) {
  const k = String(skill || '').toLowerCase();
  return [labelSkill(k), ...(ALIASES[k] || [])].filter(Boolean);
}

// Search 2: built from the skills, not the title, so it finds the people Search 1's titles miss
// (a "Staff Engineer, Kubernetes Controllers" is never a "Software Engineer" to LinkedIn).
// Groups, each an AND term: the key skill (with aliases), the role's must-have words (Kai's
// "Cloud", "IAM"), then for engineering roles the languages and the concepts the spec names, then
// the kind of role, then the industry exactly as Search 1 has it.
const LANGS = ['go', 'golang', 'java', 'python', 'rust', 'typescript', 'javascript', 'kotlin', 'scala', 'c++', 'c#', 'solidity'];
const CONCEPTS = ['model serving', 'inference', 'benchmarking', 'evaluation', 'distributed systems', 'microservices', 'apis', 'controllers', 'operators', 'observability', 'infrastructure', 'containers'];
const FAMILY_NOUNS = { engineering: ['engineer', 'developer'], security: ['security'], compliance: ['compliance', 'AML', 'KYC'], sales: ['sales', '"business development"'], devrel: ['"developer relations"', 'devrel', '"developer advocate"'] };
const mentions = (low, w) => new RegExp(`(^|[^a-z0-9+#])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9+#])`).test(low);
// What a spec says about the work, kept with the role so Search 2 can be rebuilt later without the
// spec (Kai changes the key skill on the role card, Search 2 follows).
export function specHints(text) {
  const raw = String(text || ''), low = raw.toLowerCase();
  return {
    modelSystems: /\bmodel[- ]system|\bmodels? (?:are being )?serv(?:ed|ing)\b/.test(low) ? ['model serving', 'inference', 'evaluation', 'retrieval', 'speech', 'agent infrastructure'].filter(c => mentions(low, c)) : [],
    langs: LANGS.filter(l => (l === 'go' ? /(^|[^A-Za-z0-9+])Go(?![A-Za-z0-9+])/.test(raw) : mentions(low, l))),
    concepts: CONCEPTS.filter(c => mentions(low, c) || mentions(low, c.replace(/s$/, ''))),
  };
}
// The skills a specific title names ("Rust" in "Senior Rust Engineer"): Search 2 requires them.
export const titleSkills = title => genericTitle(title) ? [] : TECH_SKILLS.filter(w => countOf(String(title).toLowerCase(), w));
export function buildSkillsBoolean({ key = '', required = [], family = '', domain = [], text = '', hints = null, title = '', exclude = DEFAULT_EXCLUDE } = {}) {
  const h = hints || specHints(text);
  const used = new Set();
  const groups = [];
  const norm = x => String(x).toLowerCase().replace(/"/g, '');
  const take = list => { const g = list.filter(x => !used.has(norm(x))); g.forEach(x => used.add(norm(x))); if (g.length) groups.push(g); };
  const inTitle = titleSkills(title);
  for (const w of inTitle) take(withAliases(w));
  const langs = family === 'engineering' ? (h.langs || []) : [];
  // "Go, Java, or equivalent" means either: a language as the key skill sits with the other languages,
  // unless the title already names the language the job is about
  const keyIsLang = LANGS.includes(String(key).toLowerCase()) && !inTitle.some(w => LANGS.includes(w));
  if (h.modelSystems?.length) take(h.modelSystems);
  else if (key) take(keyIsLang ? [...new Set([String(key).toLowerCase(), ...langs].flatMap(withAliases))].slice(0, 5) : withAliases(key));
  for (const r of required) if (r) take(withAliases(r));
  if (family === 'engineering') {
    if (!inTitle.some(w => LANGS.includes(w))) take([...new Set(langs.flatMap(withAliases))].slice(0, 4));
    take((h.modelSystems?.length ? [] : h.concepts || []).slice(0, 4).map(c => (/\s/.test(c) ? `"${c}"` : c)));
  }
  if (FAMILY_NOUNS[family]) take(FAMILY_NOUNS[family]);
  // one group on its own is not a second search, it is a keyword
  if (groups.length < 2) return '';
  return buildBoolean({ titles: [], anyOf: groups, domain, exclude });
}

// The industry words Search 1 really uses, so Search 2 has the same (Kai edits Search 1 by hand).
const INDUSTRY_WORD = /\b(crypto|blockchain|web3|fintech|defi|payments|trading|quant|digital asset|market making|stablecoin|exchange)\b/i;
export function industryOf(boolean, fallback = []) {
  const before = String(boolean || '').split(/\bNOT\b/)[0];
  for (const m of before.matchAll(/\(([^()]*)\)/g)) {
    const items = m[1].split(/\s+OR\s+/).map(t => t.trim()).filter(Boolean);
    // the titles group ("Blockchain Engineer" OR ...) is not the industry, even with an industry word in it
    if (items.some(t => JOB_WORD.test(t.replace(/"/g, '')))) continue;
    if (INDUSTRY_WORD.test(m[1])) return items;
  }
  return fallback;
}

// The Search 2 a role runs: its own if it has one, otherwise built from what the role already says
// (roles saved before 24 Sep 2026 have none).
export function secondSearchFor(role) {
  if (!role) return '';
  if (role.boolean2) return role.boolean2;
  const key = (role.recruiterSkills || [])[0] || '';
  // the same industry as the wizard showed, unless Kai has since edited Search 1 by hand
  const domain = role.booleanEdited || !(role.domain || []).length ? industryOf(role.boolean, role.domain || []) : role.domain;
  // the kind of role as read from the whole spec when it was drafted ("Protocol Lead" is engineering)
  return buildSkillsBoolean({ key, required: role.skills || [], family: role.family || familyOf(role.title), title: role.title || '', hints: role.specHints || { langs: [], concepts: [] }, domain, exclude: role.exclude || DEFAULT_EXCLUDE });
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
