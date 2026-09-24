// Turns finds from several sites into one record per human.
//
// The rule is that a wrong join is worse than a missed one. Two people welded together produce a
// record with one person's name beside another's contact details, and nobody notices until it is
// sent. So a join needs a key that identifies one human: a GitHub handle, a personal email, a
// Twitter handle, or the same handle on the same site. A shared inbox, a common name, or a name
// and a city are not enough on their own.
import { cleanHandle, cleanName, nameKey, isFullName, personalEmail } from './shape.js';

// Keys that identify one person on their own.
export function keysOf(f) {
  const out = [];
  if (f.github) out.push(`gh:${cleanHandle(f.github)}`);
  const em = personalEmail(f.email);
  if (em) out.push(`em:${em}`);
  if (f.twitter) out.push(`tw:${cleanHandle(f.twitter)}`);
  // A handle only means something together with the site it came from: "0x52" on Sherlock and
  // "0x52" on GitHub are not the same claim.
  if (f.handle) out.push(`sh:${f.source}:${cleanHandle(f.handle)}`);
  for (const a of f.aliases || []) if (a?.source && a?.handle) out.push(`sh:${a.source}:${cleanHandle(a.handle)}`);
  return [...new Set(out)];
}

function blank() {
  return {
    name: '', github: '', twitter: '', email: '', location: '', company: '',
    handles: {},            // { source: [handles] }
    urls: {},               // { source: [urls] }
    sources: [],
    evidence: [],           // [{ source, label, value }]
    lastActiveAt: null,
    score: 0,
    _keys: new Set(),
  };
}

const push = (bag, key, value) => {
  if (!value) return;
  bag[key] = bag[key] || [];
  if (!bag[key].includes(value)) bag[key].push(value);
};

function absorb(person, f) {
  // The first value wins, so a record cannot be rewritten by whatever happens to arrive later.
  if (!person.name && f.name) person.name = cleanName(f.name);
  if (!person.github && f.github) person.github = cleanHandle(f.github);
  if (!person.twitter && f.twitter) person.twitter = cleanHandle(f.twitter);
  if (!person.email) { const em = personalEmail(f.email); if (em) person.email = em; }
  for (const k of ['location', 'company']) if (!person[k] && f[k]) person[k] = f[k];

  push(person.handles, f.source, f.handle);
  for (const al of f.aliases || []) if (al?.source && al?.handle) push(person.handles, al.source, al.handle);
  push(person.urls, f.source, f.url);
  if (!person.sources.includes(f.source)) person.sources.push(f.source);
  for (const e of f.evidence || []) person.evidence.push({ source: f.source, ...e });
  if (f.lastActiveAt && (!person.lastActiveAt || f.lastActiveAt > person.lastActiveAt)) person.lastActiveAt = f.lastActiveAt;

  person.score = Math.min(100, Math.max(person.score, f.weight || 0) + (person.sources.length - 1) * 4);
  for (const k of keysOf(f)) person._keys.add(k);
  return person;
}

export function mergeFinds(finds = []) {
  if (!Array.isArray(finds)) return [];
  const byKey = new Map();
  const people = [];

  for (const f of finds) {
    if (!f || (!f.handle && !f.name)) continue;
    const keys = keysOf(f);
    const matched = [...new Set(keys.map(k => byKey.get(k)).filter(Boolean))];

    // A find that points at two people we already have is not proof they are the same person; it
    // is a sign one of the keys is shared. Keep them apart and take the one it matches best.
    let person = matched.length === 1 ? matched[0]
      : matched.length > 1 ? matched.reduce((a, b) =>
          (keys.filter(k => a._keys.has(k)).length >= keys.filter(k => b._keys.has(k)).length ? a : b))
      : null;

    // No hard key matched. A full name can still be the same person, but only when a strong field
    // agrees too, and a shared city is not a strong field.
    if (!person && isFullName(f.name)) {
      const nk = nameKey(f.name);
      person = people.find(p => nameKey(p.name) === nk && (
        (f.github && p.github && cleanHandle(p.github) === cleanHandle(f.github))
        || (f.company && p.company && f.company.toLowerCase() === p.company.toLowerCase()))) || null;
    }

    if (!person) { person = blank(); people.push(person); }
    absorb(person, f);
    // Only claim a key nobody else holds. Taking one that already points elsewhere is what let a
    // later find land on the wrong person.
    for (const k of person._keys) if (!byKey.has(k)) byKey.set(k, person);
  }

  return people
    .map(({ _keys, ...p }) => p)
    .sort((a, b) => b.score - a.score || b.sources.length - a.sources.length);
}

// Someone worth putting in front of a client: seen by more than one site, or one strong source.
export const strong = (people, min = 70) => (people || []).filter(p => p.score >= min || p.sources.length > 1);
