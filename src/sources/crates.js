// crates.io. Small, but almost everyone on it is senior, and it confirms whether a handle really
// is the GitHub account it claims to be, which is what joins the other sources together.
import { getJson } from './http.js';
import { find, isBot } from './shape.js';
import { mayFetch , HOSTS } from './registry.js';
import { log } from '../log.js';

export function toFind(user, crates = []) {
  if (!user || typeof user.login !== 'string' || !user.login) return null;
  const list = Array.isArray(crates) ? crates.filter(Boolean) : [];
  if (isBot({ handle: user.login, name: user.name })) return null;
  const gh = user.github_username_matches ? (user.login || '') : '';
  return find('crates', {
    handle: user.login || '', name: user.name || '', github: gh,
    url: user.url || (gh ? `https://github.com/${gh}` : ''),
    evidence: list.slice(0, 6).map(c => ({ label: 'maintains', value: `${c.name}${c.downloads ? ` (${c.downloads.toLocaleString('en-GB')} downloads)` : ''}` })),
    lastActiveAt: list.map(c => c.updated_at).filter(Boolean).sort().pop() || null,
    weight: gh ? 70 : 55,
  });
}

// Crates matching a search, then the people who own them.
export async function searchCrates({ q, max = 20, fetchImpl } = {}) {
  mayFetch('crates');
  if (!q) throw new Error('crates: a search is required');
  const list = await getJson(`https://crates.io/api/v1/crates?q=${encodeURIComponent(q)}&per_page=${Math.min(100, max)}`,
    { source: 'crates', gapMs: 1100, allowHosts: HOSTS.crates, fetchImpl });
  const byUser = new Map();
  for (const c of (list.crates || []).slice(0, max)) {
    const owners = await getJson(`https://crates.io/api/v1/crates/${encodeURIComponent(c.id)}/owners`,
      { source: 'crates', gapMs: 1100, allowHosts: HOSTS.crates, fetchImpl }).catch(() => ({ users: [] }));
    for (const u of owners.users || []) {
      if (u.kind === 'team') continue;
      const cur = byUser.get(u.login) || { user: u, crates: [] };
      cur.crates.push(c);
      byUser.set(u.login, cur);
    }
  }
  const out = [...byUser.values()].map(({ user, crates }) => toFind(user, crates)).filter(Boolean);
  log(`crates: ${out.length} authors for "${q}"`);
  return out;
}

// One handle, checked. Used to confirm an identity found somewhere else.
export async function lookupCrates({ handle, fetchImpl } = {}) {
  mayFetch('crates');
  const u = await getJson(`https://crates.io/api/v1/users/${encodeURIComponent(handle)}`,
    { source: 'crates', gapMs: 1100, allowHosts: HOSTS.crates, fetchImpl }).catch(() => null);
  return u?.user ? toFind(u.user) : null;
}
