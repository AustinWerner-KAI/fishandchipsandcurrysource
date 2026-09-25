import { collectSearchResults, resolveGeo } from '../linkedin.js';
import { log, warn } from '../log.js';
import { sleep, humanPauseMs } from '../limits.js';
import { buildSearchUrl, lookupGeo, widenBoolean, secondSearchFor, isGlobalLocation } from '../role.js';
import { patchCampaign } from '../config.js';
import { stopRequested } from '../stop.js';
import { sweepStart, sweepStep, sweepSet, sweepEnd } from '../sweeps.js';
import { withLearnedNot } from '../excludelearn.js';

// Where to look for people: for a remote role, wherever the recruiter said candidates may sit;
// otherwise the office location.
export function searchLocations(role) {
  if (!role) return [];
  const list = role.workType === 'remote' && Array.isArray(role.candidateLocations) ? role.candidateLocations : [role.location];
  return [...new Set(list.map(s => String(s || '').trim()).filter(s => s && !isGlobalLocation(s)))];
}

// Builds the search URL for a role. Locations become LinkedIn ids: known table first, then the
// browser, and each answer is written back to the campaign so it is only looked up once.
export async function urlForRole(page, cfg, learned = []) {
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
    try { patchCampaign(cfg.name, raw => ({ role: { ...raw.role, geo: { ...(raw.role?.geo || {}), ...geo } } })); } catch (e) { warn('could not save location ids', e.message); }
  }
  return buildSearchUrl(withLearnedNot(role.boolean, learned), ids);
}

export async function runSearch(page, store, cfg, { url, maxPages, report, seen, excludedSet } = {}) {
  // Recruiter Lite is the default for a role; "linkedin" uses normal people search.
  if (!url && !cfg.searchUrl && cfg.role && (cfg.role.source || 'recruiter') === 'recruiter') {
    const { runRecruiterSearch } = await import('./recruiter.js');
    return runRecruiterSearch(page, store, cfg, { maxPages, report, seen, excludedSet, tag: 's1' });
  }
  let searchUrl = url || cfg.searchUrl;
  if (!searchUrl && cfg.role) searchUrl = await urlForRole(page, cfg, (await import('../excludelearn.js')).learnedFor(store, cfg));
  if (!searchUrl) throw new Error('Nothing to search. Build the role in the app, or put a LinkedIn search URL in the campaign settings.');
  log('search url', searchUrl);
  const pages = maxPages || cfg.maxSearchPages || 5;
  let added = 0;
  for (let p = 1; p <= pages; p++) {
    let rows = await collectSearchResults(page, searchUrl, p);
    if (!rows.length && p === 1 && !url && cfg.role?.boolean && !cfg.role.booleanEdited) {
      // nothing at all: loosen the boolean step by step and keep the first version that returns people
      for (const w of widenBoolean(new URL(searchUrl).searchParams.get('keywords') || cfg.role.boolean)) {
        const u = new URL(searchUrl); u.searchParams.set('keywords', w.boolean);
        log(`no results. Trying ${w.step}: ${w.boolean}`);
        await sleep(humanPauseMs([4, 9]));
        rows = await collectSearchResults(page, u.toString(), 1);
        if (rows.length) { searchUrl = u.toString(); warn(`the role's boolean found nobody; using "${w.boolean}" for this search. Edit the role to make it permanent.`); break; }
      }
    }
    log(`search page ${p}: ${rows.length} results`);
    if (!rows.length && p === 1 && cfg.role?.booleanEdited) warn('your search found nobody on LinkedIn. Loosen it with Edit search (drop a NOT or an AND group) and search again.');
    if (!rows.length) break;
    store.refresh();          // pick up approvals and exclusions made in the app while this search ran
    let fresh = 0;
    for (const r of rows) {
      const url = `https://www.linkedin.com/in/${r.slug}/`;
      if (store.get(url) || store.findByRecruiterUrl(url)) continue;
      // someone Kai excluded, filed under their Recruiter address: they stay out
      const gone = store.excludedTwin(cfg.name, r.name);
      if (gone) { excludedSet?.add(gone.url); continue; }
      store.upsertLead({ url, name: r.name, headline: r.headline, location: r.location, degree: r.degree, campaign: cfg.name });
      fresh++;
    }
    added += fresh;
    store.save();
    if (p < pages) await sleep(humanPauseMs([8, 25]));
  }
  log(`search done: ${added} new leads in campaign "${cfg.name}"`);
  return added;
}

// Every way a Search can be pressed ends here: the LinkedIn search first, then the public sources.
// The sweep is a bonus on top, so a problem in it must never lose the LinkedIn results.
// 24 Sep 2026: the sweep was wired only to the command line, so a Search pressed in the app while
// a run was going (which is how Kai presses it) never swept, and the Finds list stayed empty.
export async function searchAndSweep(page, store, cfg, { url, maxPages, sources = true, maxLookups, search = runSearch, search2, sweep } = {}) {
  // A one-off URL search is a look at one page, not the role: no sweep, and no progress shown.
  const role = !url && cfg.role ? cfg.name : null;
  const lane = (cfg.role?.source || 'recruiter') === 'recruiter' && !cfg.searchUrl ? 'recruiter' : 'linkedin';
  if (role) { sweepStart(role); sweepStep(role, lane, { state: 'running' }); }
  let added;
  const report = role ? patch => sweepStep(role, lane, patch) : undefined;
  const s1 = new Set(), s2 = new Set();         // who each search found this press, for the overlap
  const excludedSet = new Set();                // people Kai excluded that either search met, once each
  try { added = await search(page, store, cfg, { url, maxPages, report, seen: s1, excludedSet }); }
  catch (e) {
    // pressing Stop closes Chrome under the search: that is a stop, not a problem
    if (role) {
      const how = stopRequested() ? 'stopped' : 'failed';
      sweepStep(role, lane, { state: how, ...(how === 'failed' ? { problem: String(e?.message || e).slice(0, 160) } : {}) });
      sweepEnd(role, how);
    }
    throw e;
  }
  if (role) sweepStep(role, lane, { state: 'done', added: added ?? 0 });
  // Search 2 (24 Sep 2026): the same Recruiter, built from the skills instead of the titles, so it
  // finds the people Search 1's titles miss. Only for Recruiter roles, and only when there is one.
  if (role && lane === 'recruiter') {
    const b2 = secondSearchFor(cfg.role);
    if (!b2) sweepStep(role, 'recruiter2', { state: 'skipped', problem: 'No Search 2: the role needs a key skill and one more skill or must-have word.' });
    else if (stopRequested()) sweepStep(role, 'recruiter2', { state: 'skipped' });
    else {
      sweepStep(role, 'recruiter2', { state: 'running' });
      const run2 = search2 || (await import('./recruiter.js')).runRecruiterSearch;
      try {
        const a2 = await run2(page, store, cfg, { maxPages, boolean: b2, tag: 's2', seen: s2, other: s1, excludedSet, report: patch => sweepStep(role, 'recruiter2', patch) });
        sweepStep(role, 'recruiter2', { state: 'done', added: a2 ?? 0 });
        added = (added || 0) + (a2 || 0);
      } catch (e) {
        if (e?.name === 'CheckpointError' || e?.name === 'NotLoggedInError') { sweepStep(role, 'recruiter2', { state: 'failed', problem: String(e.message).slice(0, 160) }); sweepEnd(role, 'failed'); throw e; }
        // Search 1's people are already saved; a Search 2 problem only costs Search 2
        sweepStep(role, 'recruiter2', { state: stopRequested() ? 'stopped' : 'failed', problem: String(e?.message || e).slice(0, 160) });
        warn('search 2 failed, Search 1 results are saved:', String(e?.message || e).slice(0, 140));
      }
    }
  }
  if (!role || !sources) { if (role) sweepEnd(role); return added; }
  // Pressing Stop during the LinkedIn half must not then start minutes of public searching.
  if (stopRequested()) { log('sources: skipped, you pressed Stop'); sweepEnd(role, 'stopped'); return added; }
  const runSources = sweep || (await import('./sources.js')).runSources;
  const progress = {
    step: (id, patch) => sweepStep(role, id, patch),
    set: patch => sweepSet(role, patch),
  };
  try {
    const r = await runSources(page, store, cfg, { ...(maxLookups ? { maxLookups } : {}), progress, excludedSet });
    sweepEnd(role, r?.failed ? 'failed' : (r?.stopped || stopRequested()) ? 'stopped' : 'done');
  }
  catch (e) {
    if (stopRequested()) sweepEnd(role, 'stopped');
    else sweepEnd(role, 'failed', { problem: String(e?.message || e).slice(0, 160) });
    if (e?.name === 'CheckpointError' || e?.name === 'NotLoggedInError') throw e;
    warn('sources: skipped after a problem, LinkedIn results are saved:', String(e?.message || e).slice(0, 140));
  }
  return added;
}
