// Stack Exchange top answerers. The only high signal source with a licence that plainly allows
// commercial use (CC BY-SA 4.0, attribution and share-alike). Security, Ethereum, Bitcoin and
// Quant each have their own site, which maps almost exactly onto the roles we work on.
import { getJson } from './http.js';
import { find, isBot, scrubEmails } from './shape.js';
import { mayFetch , HOSTS } from './registry.js';
import { log } from '../log.js';

export const SITES = {
  security: 'security.stackexchange.com',
  ethereum: 'ethereum.stackexchange.com',
  bitcoin: 'bitcoin.stackexchange.com',
  quant: 'quant.stackexchange.com',
  general: 'stackoverflow.com',
};

const strip = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

// The About text is prose. An address in it is as likely to be a team inbox or a colleague's as
// the person's own, and a wrong address merges two strangers, so none of them are taken.

export function toFinds(items, site, tag, now = Date.now()) {
  // Scores run from a handful to thousands depending on the tag, so rank within this result set
  // rather than against an absolute number that makes everybody a 95.
  const top = Math.max(1, ...(Array.isArray(items) ? items : []).filter(Boolean).map(i => i.score || 0));
  return (Array.isArray(items) ? items : []).filter(Boolean).map(it => {
    const u = it.user || {};
    const lastSeen = u.last_access_date ? u.last_access_date * 1000 : null;
    const daysAway = lastSeen ? Math.floor((now - lastSeen) / 86400000) : null;
    // Not loading the site for three months is a real change in someone's habits. A quiet month
    // is not: plenty of people answer in bursts.
    const quiet = daysAway != null && daysAway >= 90;
    return find('stackexchange', {
      handle: u.display_name || '', name: scrubEmails(u.display_name || ''),
      url: u.link || '', location: u.location || '',
      // website_url is where people put their own site, which often carries a GitHub link
      // their employer, when they wrote it plainly, stopping at the end of the phrase
      company: (strip(u.about_me).match(/\b(?:at|@)\s+([A-Z][\w&'\-]*(?:\s+[A-Z][\w&'\-]*){0,3})/) || [])[1] || '',
      lastActiveAt: u.last_access_date ? new Date(u.last_access_date * 1000).toISOString() : null,
      evidence: [
        { label: `${tag} on ${site}`, value: `${it.post_count} answers, score ${it.score}` },
        { label: 'reputation', value: String(u.reputation ?? '') },
        ...(quiet ? [{ label: 'gone quiet', value: `not been on the site for ${daysAway} days` }] : []),
      ],
      // how they rank against the other top answerers for this tag
      weight: 45 + Math.round(45 * ((it.score || 0) / top)),
    });
  }).filter(f => f.handle && !isBot({ handle: f.handle, name: f.name }));
}

// The people ranked highest for one tag on one site. `period` of 'month' gives the ones active now.
export async function searchStackExchange({ tag, site = 'security', period = 'all_time', key = process.env.STACKEXCHANGE_KEY || '', fetchImpl } = {}) {
  mayFetch('stackexchange');
  if (!tag) throw new Error('stackexchange: a tag is required');
  const host = SITES[site] || site;
  const top = await getJson(
    `https://api.stackexchange.com/2.3/tags/${encodeURIComponent(tag)}/top-answerers/${period}?site=${encodeURIComponent(host)}${key ? `&key=${key}` : ''}`,
    { source: 'stackexchange', gapMs: 1200, allowHosts: HOSTS.stackexchange, fetchImpl });
  const items = top.items || [];
  if (!items.length) { log(`stackexchange: nothing for ${tag} on ${host}`); return []; }

  // The ranking gives a thin user object. One more call fills in location, website, when they
  // last loaded the site and their reputation trend, all of which the default shape includes.
  const ids = items.map(i => i.user?.user_id).filter(Boolean).join(';');
  const full = ids ? await getJson(
    `https://api.stackexchange.com/2.3/users/${ids}?site=${encodeURIComponent(host)}&pagesize=100${key ? `&key=${key}` : ''}`,
    { source: 'stackexchange', gapMs: 1200, allowHosts: HOSTS.stackexchange, fetchImpl })
    .catch(e => { if (e.rateLimited) log(`stackexchange: ${e.message}, ranking only this time`); return { items: [] }; }) : { items: [] };
  const detail = new Map((full.items || []).map(u => [u.user_id, u]));
  const merged = items.map(i => ({ ...i, user: { ...i.user, ...(detail.get(i.user?.user_id) || {}) } }));
  const out = toFinds(merged, host, tag);
  log(`stackexchange: ${out.length} for ${tag} on ${host}`);
  return out;
}
