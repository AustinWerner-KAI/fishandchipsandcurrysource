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

// Words that mean "this person is a recruiter, not a candidate".
export const DEFAULT_EXCLUDE = ['recruiter', 'talent acquisition', 'headhunter'];

// Domain words we look for in a spec. First match wins the domain group of the boolean.
const DOMAINS = [
  { words: ['crypto', 'digital asset', 'digital assets', 'blockchain', 'web3', 'defi', 'exchange', 'custody', 'stablecoin', 'tokenis', 'tokeniz'],
    boolean: ['crypto', '"digital asset"', 'blockchain', 'web3'] },
  { words: ['fintech', 'payments', 'neobank'], boolean: ['fintech', 'payments'] },
  { words: ['trading', 'market making', 'market maker', 'hedge fund', 'prop trading', 'quant'], boolean: ['trading', '"market making"', 'quant'] },
];

const SKILL_WORDS = [
  'solidity', 'rust', 'golang', 'go', 'python', 'typescript', 'kubernetes', 'aws', 'react', 'node',
  'aml', 'kyc', 'mica', 'vara', 'fca', 'compliance', 'licensing', 'regulatory',
  'custody', 'derivatives', 'options', 'perpetuals', 'market making', 'liquidity', 'otc',
  'treasury', 'risk', 'audit', 'security', 'smart contract', 'smart contracts', 'zk', 'evm', 'layer 2', 'l2',
  'sales', 'business development', 'partnerships', 'institutional', 'growth', 'marketing', 'product', 'tokenomics',
  'listings', 'ecosystem', 'devrel', 'developer relations', 'community',
];

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

// "Head of Compliance" -> ["Head of Compliance", "Compliance Director", "VP Compliance", "Compliance Lead"]
export function titleVariants(title) {
  const t = clean(title);
  if (!t) return [];
  const out = new Set([t]);
  let m;
  if ((m = t.match(/^head of (.+)$/i))) { const x = m[1]; out.add(`${x} Director`); out.add(`Director of ${x}`); out.add(`VP ${x}`); out.add(`${x} Lead`); }
  else if ((m = t.match(/^(?:vp|vice president)(?: of)? (.+)$/i))) { const x = m[1]; out.add(`Head of ${x}`); out.add(`${x} Director`); out.add(`SVP ${x}`); }
  else if ((m = t.match(/^director of (.+)$/i)) || (m = t.match(/^(.+) director$/i))) { const x = m[1]; out.add(`Head of ${x}`); out.add(`Director of ${x}`); out.add(`${x} Director`); out.add(`VP ${x}`); }
  else if ((m = t.match(/^chief (.+) officer$/i))) { const x = m[1]; out.add(`Head of ${x}`); out.add(`VP ${x}`); out.add(`${x} Director`); }
  else if ((m = t.match(/^(senior|lead|principal|staff) (.+)$/i))) { const x = m[2]; out.add(x); out.add(`Senior ${x}`); out.add(`Lead ${x}`); out.add(`Principal ${x}`); }
  else if ((m = t.match(/^(.+) (engineer|developer)$/i))) { const x = m[1]; out.add(`${x} Engineer`); out.add(`${x} Developer`); out.add(`Senior ${x} Engineer`); }
  else if ((m = t.match(/^(.+) manager$/i))) { const x = m[1]; out.add(`${x} Lead`); out.add(`Head of ${x}`); }
  return [...out].map(clean).filter((v, i, a) => a.findIndex(o => o.toLowerCase() === v.toLowerCase()) === i).slice(0, 5);
}

function quote(s) { s = clean(s).replace(/"/g, ''); return /\s/.test(s) ? `"${s}"` : s; }
function group(items) { const q = items.map(quote).filter(Boolean); return q.length > 1 ? `(${q.join(' OR ')})` : q[0] || ''; }

// Keeps it simple on purpose: titles AND domain [AND skills] NOT recruiters.
export function buildBoolean({ titles = [], domain = [], skills = [], exclude = DEFAULT_EXCLUDE } = {}) {
  const parts = [group(titles), group(domain), group(skills)].filter(Boolean);
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
  return {
    title, location, workType,
    // remote roles: where the candidate may sit. Starts equal to the office location; the recruiter widens it.
    candidateLocations: location ? [location] : [],
    titles,
    domain: domain ? domain.boolean : [],
    skills,
    exclude: [...DEFAULT_EXCLUDE],
    boolean: buildBoolean({ titles, domain: domain ? domain.boolean : [], skills: [], exclude: DEFAULT_EXCLUDE }),
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
