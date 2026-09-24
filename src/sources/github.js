// GitHub. The best evidence there is of what someone actually builds, and the hub every other
// source joins onto.
//
// READ THIS BEFORE CHANGING ANYTHING HERE. GitHub's Acceptable Use Policy says information from
// GitHub may not be used "for spamming purposes, including for the purposes of sending unsolicited
// emails to users or selling personal information, such as to recruiters, headhunters, and job
// boards". So GitHub is used here to FIND and CHECK people, and for nothing else: the email field
// is deliberately not collected, nothing from GitHub is ever exported, and no message is ever sent
// to an address that came from here.
import { getJson } from './http.js';
import { find, isBot, scrubEmails } from './shape.js';
import { mayFetch , HOSTS } from './registry.js';
import { log, warn } from '../log.js';

const API = 'https://api.github.com';
const auth = () => (process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {});
const headers = () => ({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...auth() });

export function toFind(u, extra = {}) {
  if (!u || typeof u.login !== 'string' || !u.login) return null;
  if (u.type === 'Organization' || isBot({ handle: u.login, name: u.name })) return null;
  return find('github', {
    handle: u.login, name: scrubEmails(u.name || ''), github: u.login.toLowerCase(),
    url: u.html_url || `https://github.com/${u.login}`,
    location: scrubEmails(u.location || ''), company: scrubEmails(String(u.company || '').replace(/^@/, '')),
    twitter: u.twitter_username || '',
    // email is left out on purpose: see the note at the top of this file
    evidence: [
      ...(u.public_repos != null ? [{ label: 'public repositories', value: String(u.public_repos) }] : []),
      ...(u.followers != null ? [{ label: 'followers', value: String(u.followers) }] : []),
      ...(u.hireable ? [{ label: 'open to work', value: 'says so on their profile' }] : []),
      // the bio is free text and is where people write "hire me at ...". Their policy is that we
      // do not take an email from GitHub, so no address survives into anything we show.
      ...(u.bio ? [{ label: 'bio', value: scrubEmails(u.bio).slice(0, 140) }] : []),
    ],
    lastActiveAt: extra.lastActiveAt || u.updated_at || null,
    weight: u.hireable ? 90 : 65,
  });
}

// GitHub's own search syntax: location:, language:, followers:>50, repos:>10.
export async function searchGitHub({ q, max = 30, hydrate = true, fetchImpl } = {}) {
  mayFetch('github');
  if (!q) throw new Error('github: a search is required');
  if (!process.env.GITHUB_TOKEN) warn('github: no GITHUB_TOKEN set, so only 10 searches an hour are allowed');
  const r = await getJson(`${API}/search/users?q=${encodeURIComponent(q)}&per_page=${Math.min(100, max)}`,
    { source: 'github', gapMs: 2200, allowHosts: HOSTS.github, headers: headers(), fetchImpl });
  const logins = (r.items || []).slice(0, max).map(i => i.login);
  if (!hydrate) return logins.map(l => find('github', { handle: l, github: l.toLowerCase(), url: `https://github.com/${l}`, weight: 50 }));
  const out = [];
  for (const login of logins) {
    // a throttle or a bad token stops the whole source, so it is reported rather than looking
    // like "nobody on GitHub matched"
    const f = await lookupGitHub({ handle: login, fetchImpl });
    if (f) out.push(f);
  }
  log(`github: ${out.length} people for "${q}"`);
  return out;
}

// One person, with when they last pushed anything. That date is the timing signal.
export async function lookupGitHub({ handle, withActivity = true, fetchImpl } = {}) {
  mayFetch('github');
  const u = await getJson(`${API}/users/${encodeURIComponent(handle)}`,
    { source: 'github', gapMs: 900, allowHosts: HOSTS.github, headers: headers(), fetchImpl })
    .catch(e => { if (e.rateLimited || e.refused || e.timedOut) throw e; return null; });
  if (!u) return null;
  let lastActiveAt = null;
  if (withActivity) {
    const ev = await getJson(`${API}/users/${encodeURIComponent(handle)}/events/public?per_page=30`,
      { source: 'github', gapMs: 900, allowHosts: HOSTS.github, headers: headers(), fetchImpl }).catch(() => []);
    lastActiveAt = (Array.isArray(ev) ? ev : []).map(e => e.created_at).filter(Boolean).sort().pop() || null;
  }
  return toFind(u, { lastActiveAt });
}
