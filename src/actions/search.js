import { collectSearchResults, resolveGeo } from '../linkedin.js';
import { log, warn } from '../log.js';
import { sleep, humanPauseMs } from '../limits.js';
import { buildSearchUrl, lookupGeo } from '../role.js';
import { patchCampaign } from '../config.js';

// Where to look for people: for a remote role, wherever the recruiter said candidates may sit;
// otherwise the office location.
export function searchLocations(role) {
  if (!role) return [];
  const list = role.workType === 'remote' && role.candidateLocations?.length ? role.candidateLocations : [role.location];
  return [...new Set(list.map(s => String(s || '').trim()).filter(Boolean))];
}

// Builds the search URL for a role. Locations become LinkedIn ids: known table first, then the
// browser, and each answer is written back to the campaign so it is only looked up once.
export async function urlForRole(page, cfg) {
  const role = cfg.role;
  if (!role?.boolean) throw new Error('The role has no boolean search yet. Build it in the app first.');
  const geo = { ...(role.geo || {}) };
  const ids = [];
  for (const name of searchLocations(role)) {
    const key = name.toLowerCase();
    let id = geo[key] || lookupGeo(name);
    if (!id && page) id = (await resolveGeo(page, name))?.id || null;
    if (id) { ids.push(id); geo[key] = id; continue; }
    // Country fallback is used for this run only, never remembered, so the city is asked for again next time.
    const loose = lookupGeo(name, { loose: true });
    if (loose) { ids.push(loose); warn(`using the country for "${name}"; LinkedIn did not give a closer match. Will try again next search.`); }
    else warn(`could not find "${name}" on LinkedIn. Searching without that location filter. Open the search on LinkedIn, set the location by hand and paste the URL into the campaign settings.`);
  }
  if (JSON.stringify(geo) !== JSON.stringify(role.geo || {})) {
    try { patchCampaign(cfg.name, { role: { ...role, geo } }); } catch (e) { warn('could not save location ids', e.message); }
  }
  return buildSearchUrl(role.boolean, ids);
}

export async function runSearch(page, store, cfg, { url, maxPages } = {}) {
  let searchUrl = url || cfg.searchUrl;
  if (!searchUrl && cfg.role) searchUrl = await urlForRole(page, cfg);
  if (!searchUrl) throw new Error('Nothing to search. Build the role in the app, or put a LinkedIn search URL in the campaign settings.');
  log('search url', searchUrl);
  const pages = maxPages || cfg.maxSearchPages || 5;
  let added = 0;
  for (let p = 1; p <= pages; p++) {
    const rows = await collectSearchResults(page, searchUrl, p);
    log(`search page ${p}: ${rows.length} results`);
    if (!rows.length) break;
    let fresh = 0;
    for (const r of rows) {
      const url = `https://www.linkedin.com/in/${r.slug}/`;
      if (store.get(url)) continue;
      store.upsertLead({ url, name: r.name, headline: r.headline, location: r.location, campaign: cfg.name });
      fresh++;
    }
    added += fresh;
    store.save();
    if (p < pages) await sleep(humanPauseMs([8, 25]));
  }
  log(`search done: ${added} new leads in campaign "${cfg.name}"`);
  return added;
}
