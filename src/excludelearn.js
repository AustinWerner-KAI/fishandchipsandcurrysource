// What Kai's excludes teach both searches (24 Sep 2026).
// When he excludes several people who share a word or a company (their title says "Consultant",
// they all work at the same agency) and nobody he kept has it, both searches leave it out from
// then on. Worked out fresh from his picks every time, so it follows him: put someone back, or
// keep someone with that word, and it stops. Undo on the role card turns one off for good.
//
// LinkedIn's NOT matches anywhere on a profile, including old jobs, so this is kept strict:
// at least 3 of his excludes, at least a quarter of them, several times more common among his
// excludes than among everyone else in the role, never a word from the role's own searches or
// places, and never anything a kept person has.
import { features } from './learn.js';
import { secondSearchFor } from './role.js';

export const MIN_EXCLUDED = 3;
export const MIN_KEPT = 1;
const MAX_REST_SHARE = 0.1;   // a word more than 1 in 10 of the others have is part of the market, not a pattern
const MAX_TERMS = 6;
const LIFT = 3;
const KEPT = new Set(['invited', 'accepted', 'messaged', 'replied', 'done']);
// seniority words say nothing about fit on their own (juniors are already held back locally)
const NEVER = new Set('senior sr junior jr lead principal staff mid level ii iii'.split(' '));
// never a reason to leave anyone out: pronouns and words about who someone is rather than their work
const PERSONAL = new Set(('he him his she her hers they them their theirs xe xem ze zir pronouns ' +
  'woman women female male man men mum mom mother father dad parent veteran lgbt lgbtq lgbtqia queer gay lesbian trans ' +
  'christian muslim jewish hindu sikh buddhist catholic black white asian latina latino latinx hispanic african arab indian ' +
  'disabled disability neurodivergent autistic adhd dyslexic deaf blind immigrant refugee visa sponsorship citizen').split(' '));

const low = s => String(s || '').toLowerCase();
const plain = s => low(s).normalize('NFKD').replace(/[̀-ͯ]/g, '');
const words = s => plain(s).replace(/[^a-z0-9+#. ]+/g, ' ').split(/\s+/).map(w => w.replace(/^\.+|\.+$/g, '')).filter(w => w.length > 1);

const isKept = l => (l.approved && l.status === 'new') || KEPT.has(l.status) || !!l.acceptedAt || !!l.invitedAt;
const isExcluded = l => l.status === 'skipped' && l.skippedByHand;

// A person's terms: words and two-word phrases from their headline and current title, and their company.
function termsOf(l) {
  const out = new Set();
  for (const src of [l.headline, l.currentTitle]) {
    if (!src) continue;
    for (const f of features({ headline: src })) if (!f.includes(':') && !f.includes(' ')) out.add(f);
  }
  const co = plain(l.company).replace(/[()"':]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (co && co.length > 2) out.add(`company:${co}`);
  return out;
}

// The role's own words: its searches, titles, skills, industry and places. A learned term never
// cuts across what the role asks for.
function roleWords(role) {
  const text = [role.boolean, role.boolean2, secondSearchFor(role), role.title, role.team, ...(role.titles || []), ...(role.skills || []),
    ...(role.recruiterSkills || []), ...(role.domain || []), ...(role.suggestedSkills || []), role.location, ...(role.candidateLocations || []),
    role.client?.name, ...(role.client?.otherNames || [])].filter(Boolean).join(' ');
  const out = new Set();
  for (const w of words(text)) { out.add(w); out.add(stem(w)); }
  return out;
}
const stem = w => w.length > 3 ? w.replace(/(ies)$/, 'y').replace(/(?<!s)s$/, '') : w;

// [{ term, n, label }] where term is what goes in the NOT group and n how many excludes share it.
export function learnExcludes(leads, role) {
  if (!role) return [];
  const off = new Set((role.learnedExcludeOff || []).map(low));
  const excluded = leads.filter(isExcluded);
  const kept = leads.filter(isKept), rest = leads.filter(l => !isExcluded(l));
  // nothing is learned from excludes alone: at least one kept person shows what good looks like
  if (excluded.length < MIN_EXCLUDED || kept.length < MIN_KEPT) return [];
  const keptTerms = new Set(kept.flatMap(l => [...termsOf(l)]));
  const count = (list) => { const m = new Map(); for (const l of list) for (const t of termsOf(l)) m.set(t, (m.get(t) || 0) + 1); return m; };
  const inEx = count(excluded), inRest = count(rest);
  const own = roleWords(role);
  const need = Math.max(MIN_EXCLUDED, Math.ceil(excluded.length * 0.25));
  let picks = [];
  for (const [t, n] of inEx) {
    if (n < need || keptTerms.has(t)) continue;
    const text = t.startsWith('company:') ? t.slice(8) : t;
    if (off.has(text)) continue;
    const ws = words(text);
    if (!ws.length || ws.some(w => own.has(w) || own.has(stem(w)) || PERSONAL.has(w))) continue;
    if (!t.startsWith('company:') && (ws.every(w => NEVER.has(w)) || text.length < 3)) continue;
    // several times more common among his excludes than among everyone else in the role, and rare there
    const shareEx = n / excluded.length, shareRest = (inRest.get(t) || 0) / Math.max(1, rest.length);
    if (shareRest > MAX_REST_SHARE || (shareRest && shareEx < LIFT * shareRest)) continue;
    picks.push({ term: text, n, company: t.startsWith('company:') });
  }
  // the same word as a company and as a title word: keep one
  const seen = new Set();
  picks = picks.sort((a, b) => b.n - a.n || a.term.length - b.term.length).filter(p => !seen.has(p.term) && seen.add(p.term));
  return picks.slice(0, MAX_TERMS).map(p => ({ term: p.term, n: p.n, company: p.company }));
}

// Adds the learned terms to a boolean's NOT group (or gives it one). Terms already there are skipped.
export function withLearnedNot(boolean, learned = []) {
  const b = String(boolean || '').trim();
  if (!b || !learned.length) return b;
  // anything but plain letters and digits is quoted, with no brackets or quotes inside
  const q = t => { const c = String(t).replace(/[()"]+/g, ' ').replace(/\s+/g, ' ').trim(); return /^[a-z0-9]+$/i.test(c) ? c : `"${c}"`; };
  const has = t => new RegExp(`(^|[\\s("])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[\\s)"])`, 'i').test(b.split(/\bNOT\b/).slice(1).join(' '));
  const add = [...new Set(learned.map(x => x.term || x).filter(t => t && !has(t)).map(q))].filter(t => t !== '""');
  if (!add.length) return b;
  const m = /\sNOT\s+\(([^()]*)\)\s*$/.exec(b);
  if (m) return `${b.slice(0, m.index)} NOT (${m[1]} OR ${add.join(' OR ')})`;
  const one = /\sNOT\s+("[^"]*"|\S+)\s*$/.exec(b);
  if (one) return `${b.slice(0, one.index)} NOT (${one[1]} OR ${add.join(' OR ')})`;
  return `${b} NOT ${add.length > 1 ? `(${add.join(' OR ')})` : add[0]}`;
}

// What a role's searches learned, from the people on file for it.
export const learnedFor = (store, cfg) => cfg?.role ? learnExcludes(store.leads({ campaign: cfg.name }), cfg.role) : [];
