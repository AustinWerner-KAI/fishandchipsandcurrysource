// npm package maintainers. The registry hands over working email addresses with no key at all,
// tied to the exact package someone maintains. npm's terms forbid passing npm data on to anyone
// else, so these stay inside Sourcer and are never exported or shared.
import { getJson } from './http.js';
import { find, isBot, personalEmail } from './shape.js';
import { mayFetch , HOSTS } from './registry.js';
import { log } from '../log.js';

export function toFinds(objects = []) {
  const people = new Map();
  for (const o of (Array.isArray(objects) ? objects : []).filter(Boolean)) {
    const pkg = o.package || o;
    if (!pkg || typeof pkg !== 'object') continue;
    const when = pkg.date || null;
    const people_ = [pkg.publisher, ...(Array.isArray(pkg.maintainers) ? pkg.maintainers : [])].filter(p => p && typeof p === 'object');
    for (const p of people_) {
      const key = (p.username || p.name || p.email || '').toLowerCase();
      if (!key) continue;
      // release robots publish more packages than anyone; none of them are worth calling
      if (isBot({ handle: p.username, name: p.name, email: p.email })) continue;
      const cur = people.get(key) || find('npm', {
        handle: p.username || p.name || '', name: p.name && p.name !== p.username ? p.name : '',
        email: personalEmail(p.email), url: `https://www.npmjs.com/~${p.username || p.name}`,
        evidence: [], lastActiveAt: when, weight: 55,
      });
      if (!cur.email) cur.email = personalEmail(p.email);
      if (when && (!cur.lastActiveAt || when > cur.lastActiveAt)) cur.lastActiveAt = when;
      if (cur.evidence.length < 6 && !cur.evidence.some(e => e.value === pkg.name)) {
        cur.evidence.push({ label: 'maintains', value: pkg.name });
      }
      cur.weight = Math.min(90, 55 + cur.evidence.length * 5);
      people.set(key, cur);
    }
  }
  return [...people.values()];
}

// `text` takes npm's own search syntax: "keywords:ethereum", "maintainer:sindresorhus".
export async function searchNpm({ text, size = 50, fetchImpl } = {}) {
  mayFetch('npm');
  if (!text) throw new Error('npm: a search is required');
  const r = await getJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${Math.min(250, size)}`,
    { source: 'npm', gapMs: 1100, allowHosts: HOSTS.npm, fetchImpl });
  const out = toFinds(r.objects || []);
  log(`npm: ${out.length} maintainers for "${text}"`);
  return out;
}
