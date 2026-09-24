// HackerOne researcher profiles. The one source that returns a real name, a GitHub handle and a
// Twitter handle together, which is what turns a pile of pseudonyms into people we can actually
// approach. Their terms say nothing about automated access, which is unresolved rather than
// permitted, so this is used sparingly and only to look people up.
import { politeFetch } from './http.js';
import { find } from './shape.js';
import { mayFetch , HOSTS } from './registry.js';
import { log, warn } from '../log.js';

const ENDPOINT = 'https://hackerone.com/graphql';
const FIELDS = 'username name reputation signal impact bio website twitter_handle github_handle created_at';

async function query(q, fetchImpl) {
  const res = await politeFetch(ENDPOINT, {
    source: 'hackerone', gapMs: 1500, allowHosts: HOSTS.hackerone, method: 'POST', fetchImpl,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(`hackerone: ${json.errors[0].message}`.slice(0, 160));
  return json.data;
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(+v) ? +v : null);

export function toFind(u) {
  if (!u || typeof u.username !== 'string' || !u.username) return null;
  const signal = num(u.signal), impact = num(u.impact), rep = num(u.reputation);
  return find('hackerone', {
    handle: u.username, name: u.name || '', github: (u.github_handle || '').toLowerCase(),
    twitter: u.twitter_handle || '', url: `https://hackerone.com/${u.username}`,
    evidence: [
      { label: 'reputation', value: String(Math.round(rep ?? 0)) },
      // signal is how often their reports are valid, impact is how serious the bugs are
      ...(signal != null ? [{ label: 'report quality', value: signal.toFixed(2) }] : []),
      ...(impact != null ? [{ label: 'severity of findings', value: impact.toFixed(1) }] : []),
    ],
    lastActiveAt: u.created_at || null,
    weight: Math.min(95, 40 + Math.round((impact || 0) * 1.5) + Math.round((signal || 0) * 3)),
  });
}

// One researcher by their handle. This is the identity join: handle in, real name and GitHub out.
export async function lookupHackerOne({ handle, fetchImpl } = {}) {
  mayFetch('hackerone');
  if (!handle) throw new Error('hackerone: a handle is required');
  try {
    const data = await query(`{user(username:${JSON.stringify(String(handle))}){${FIELDS}}}`, fetchImpl);
    const f = toFind(data?.user);
    if (f) log(`hackerone: ${handle} is ${f.name || 'unnamed'}${f.github ? ` (github ${f.github})` : ''}`);
    return f;
  } catch (e) { warn('hackerone lookup failed', handle, e.message); return null; }
}

// Several handles at once, one request each, politely spaced.
export async function lookupMany({ handles = [], fetchImpl } = {}) {
  const out = [];
  for (const h of handles) {
    const f = await lookupHackerOne({ handle: h, fetchImpl });
    if (f) out.push(f);
  }
  return out;
}
