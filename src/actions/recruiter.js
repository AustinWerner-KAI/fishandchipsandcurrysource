// Search in Recruiter Lite with the role's boolean and locations, and collect the people.
// Recruiter results link only to Recruiter profiles (/talent/profile/<id>); the person's normal
// /in/ address is looked up later, only for people Kai approves (see publicUrlFor).
import { goto, snap, saveDom, guard, typeLikeHuman, ensureWide, loadedNarrow, WIDE } from '../browser.js';
import { SEL, firstVisible } from '../selectors.js';
import { tenureMonths, experienceMonths } from '../company.js';
import { log, warn } from '../log.js';
import { sleep, randomBetween, humanPauseMs } from '../limits.js';
import { searchLocations } from './search.js';
import { normalizeUrl } from '../store.js';
import { learnedFor, withLearnedNot } from '../excludelearn.js';

const SEARCH_URL = 'https://www.linkedin.com/talent/search';

const firstHref = page => page.locator('[data-test-row-lockup-full-name] a').first().getAttribute('href', { timeout: 1000 }).catch(() => null);

// Waits for result rows. With `changedFrom`, waits until the first row is a different person,
// so rows from before a filter or page change are never read.
async function waitForResults(page, ms = 15000, changedFrom) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.locator(SEL.recruiterResultItem.join(', ')).count()) {
      if (changedFrom === undefined) return true;
      const now = await firstHref(page);
      if (now && now !== changedFrom) return true;
    }
    if (await page.locator('text=/No results|didn.t find any|Try removing/i').locator('visible=true').count()) return false;
    await sleep(700);
  }
  return false;   // nothing new showed up in time
}

export async function readRecruiterResults(page) {
  return page.evaluate(sel => {
    const out = [], seen = new Set();
    for (const li of document.querySelectorAll(sel)) {
      const a = li.querySelector('[data-test-row-lockup-full-name] a, a[data-test-link-to-profile-link]');
      if (!a) continue;
      const key = a.href.split('?')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      const t = s => (li.querySelector(s)?.innerText || '').replace(/\s+/g, ' ').trim();
      const degree = (t('[data-test-lockup-degree] .artdeco-entity-lockup__degree') || t('[data-test-lockup-degree]')).match(/1st|2nd|3rd\+?/)?.[0] || '';
      out.push({
        recruiterUrl: a.href.split('?')[0],
        name: a.innerText.replace(/\s+/g, ' ').trim(),
        headline: t('[data-test-row-lockup-headline]'),
        location: t('[data-test-row-lockup-location]'),
        industry: t('[data-test-current-employer-industry]').replace(/^·\s*/, ''),
        // first experience line is the current job: "Senior Security Engineer at Kraken · 2 yrs"
        company: ((t('[data-test-description-description]').split('·')[0] || '').match(/\sat\s(.+)$/i)?.[1] || '').trim(),
        // How long at that employer. Recruiter groups roles by company, so the first group's
        // header carries the total; if it does not, the group's own entries are read instead.
        tenureText: (() => {
          const group = li.querySelector('[data-test-history-group]') || li.querySelector('[data-test-history]');
          if (!group) return t('[data-test-description-entry-date-duration]');
          const header = (group.querySelector('[data-test-history-group-header]')?.innerText || '').replace(/\s+/g, ' ').trim();
          if (/\d+\s*(yrs?|years?|mos?|months?)/i.test(header)) return header;
          return [...group.querySelectorAll('[data-test-description-entry-date-duration]')]
            .map(e => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
        })(),
        companyUrl: (li.querySelector('a[href*="/company/"]')?.href || '').split('?')[0],
        // Every role on the card, so how long they have actually worked can be worked out.
        history: [...li.querySelectorAll('[data-test-description-entry-term], li:has([data-test-description-entry-date-duration])')]
          .map(e => ({
            // Only the job title, never the whole row: the employer's name landing in here once
            // made "Head of Data at Co-op" read as an internship.
            term: (e.querySelector('[data-test-description-entry-term]')?.innerText
              || (e.querySelector('[data-test-description-description]')?.innerText || '').split('·')[0]
              || '').replace(/\s+/g, ' ').trim().slice(0, 160),
            duration: (e.querySelector('[data-test-description-entry-date-duration]')?.innerText || '').replace(/\s+/g, ' ').trim(),
          }))
          .filter(h => h.duration),
        // Recruiter hides older roles behind a "show more". If one is there, we have not seen it all.
        historyTruncated: !!li.querySelector('[data-test-expandable-list] button[aria-expanded="false"], [data-test-expandable-list] [aria-expanded="false"]')
          || /show \d+ more|see more|\+\d+ more/i.test(li.querySelector('[data-test-expandable-list]')?.innerText || ''),
        currentTitle: (li.querySelector('[data-test-description-entry-term]')?.innerText || '').replace(/\s+/g, ' ').trim(),
        degree,
      });
    }
    return out;
  }, SEL.recruiterResultItem.join(', '));
}

// Opens a left-panel filter (Locations, Skills), types the value and picks the matching suggestion.
// Everything is looked up inside that filter's own wrapper, so the skill can never go into the
// location box, and a suggestion must contain the words typed: "Azure" never becomes "Vermont".
export async function addFacet(page, what, value) {
  await closeFacets(page);
  const wrapper = await firstVisible(page, what === 'location' ? SEL.recruiterLocationFacet : SEL.recruiterSkillFacet, 5000);
  if (!wrapper) { await snap(page, `recruiter-no-${what}-filter`); await saveDom(page, `recruiter-no-${what}-filter`); warn(`could not find the Recruiter ${what} filter`); return false; }
  const btn = await firstVisible(wrapper, [...SEL.recruiterFacetEdit, ...(what === 'location' ? SEL.recruiterAddLocation : SEL.recruiterAddSkill)], 3000);
  if (btn) { await btn.click(); await sleep(randomBetween(600, 1100)); }
  const input = await firstVisible(wrapper, SEL.recruiterFacetBox, 4000);
  if (!input) { await closeFacets(page); await snap(page, `recruiter-no-${what}-input`); await saveDom(page, `recruiter-no-${what}-input`); warn(`Recruiter ${what} box did not open; searching without "${value}"`); return false; }
  const before = await firstHref(page);
  await input.click();
  await input.fill('').catch(() => {});
  await typeLikeHuman(input, value);
  await sleep(randomBetween(1200, 2000));
  // suggestions: inside the filter first, then the list this box points at, then any open list
  const listId = await input.getAttribute('aria-controls').catch(() => null) || await input.getAttribute('aria-owns').catch(() => null);
  const scopes = [wrapper, ...(listId ? [page.locator(`[id="${listId.replace(/"/g, '')}"]`)] : []), page];
  const want = value.toLowerCase().split(/[ ,]+/).filter(Boolean);
  let opt = null, label = '';
  for (const scope of scopes) {
    for (const sel of ['[role="option"]', '.artdeco-typeahead__result', ...SEL.recruiterFacetOption]) {
      const opts = scope.locator(sel).locator('visible=true');
      const n = Math.min(await opts.count().catch(() => 0), 8);
      for (let i = 0; i < n && !opt; i++) {
        const text = ((await opts.nth(i).innerText().catch(() => '')).split('\n')[0] || '').trim();
        if (text && want.every(w => text.toLowerCase().includes(w))) { opt = opts.nth(i); label = text; }
      }
      if (opt) break;
    }
    if (opt) break;
  }
  if (!opt) {
    await closeFacets(page);
    await snap(page, `recruiter-no-${what}-match`);
    await saveDom(page, `recruiter-no-${what}-match`);
    warn(`Recruiter had no ${what} matching "${value}"; searching without it`);
    return false;
  }
  await opt.click();
  log(`recruiter ${what}: ${value} -> ${label}`);
  const changed = await waitForResults(page, 12000, before);
  // the same person can still be first after a filter, so an unchanged list is fine when the chip shows
  const chip = await wrapper.getByText(label.split(',')[0], { exact: false }).locator('visible=true').count().catch(() => 0);
  await closeFacets(page);
  if (!changed && !chip) { await snap(page, `recruiter-${what}-not-applied`); warn(`Recruiter ${what} "${value}" did not apply`); return false; }
  await sleep(randomBetween(800, 1600));
  return true;
}

// Closes any open filter box so the next one starts clean.
async function closeFacets(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); }).catch(() => {});
  await sleep(300);
}

// At most two skills: more than that narrows Recruiter too far.
// "Burlington, Vermont, United States" is outside a New York search. A bare area with no commas
// ("Buffalo-Niagara Falls Area", "United States") is kept for Kai to judge.
export function outsideArea(location, locs) {
  const l = String(location || '').toLowerCase();
  if (!locs?.length || !l || !l.includes(',')) return false;
  return !locs.some(x => l.includes(String(x).toLowerCase().split(',')[0].trim()));
}

export function recruiterSkills(role) {
  return [...new Set((role?.recruiterSkills || []).map(s => String(s).trim()).filter(Boolean))].slice(0, 2);
}

async function nextPage(page, pageNo) {
  const before = await firstHref(page);
  const next = await firstVisible(page, SEL.recruiterNextPage, 1500);
  if (next && await next.isEnabled().catch(() => false)) { await next.click(); }
  else {
    const link = page.locator('li[data-test-pagination-link]', { hasText: new RegExp(`^\\s*${pageNo}\\b`) }).first();
    if (!(await link.count())) return false;                  // last page
    await link.click();
  }
  await sleep(randomBetween(2000, 3500));
  await guard(page);
  return waitForResults(page, 12000, before);                  // false if the same people are still showing
}

// Recruiter shows the search box in the top bar, but in a narrow window it is collapsed to just the
// magnifier (24 Sep 2026: a search tab opened 796px wide and stopped before it started).
// ensureWide() is the real fix; this is the fallback if the page still comes up collapsed.
// Exported so the browser test can drive the collapsed case.
export async function openSearchBox(page) {
  const box = await firstVisible(page, SEL.recruiterSearchBox, 8000);
  if (box) return box;
  const opener = await firstVisible(page, SEL.recruiterSearchOpen, 2000);
  if (!opener) return null;
  const was = new URL(page.url()).pathname;
  await opener.click().catch(() => {});
  await sleep(randomBetween(400, 900));
  // Clicking the wrong thing in the top bar navigates away; going back is better than searching
  // from whatever page we landed on. Only a different page counts: Recruiter may add to the
  // address when the box opens, and that is not leaving.
  if (new URL(page.url()).pathname !== was) { warn('the search box opener moved the page; going back'); await page.goBack().catch(() => {}); return null; }
  return firstVisible(page, SEL.recruiterSearchBox, 5000);
}

// The page was laid out narrow even so: lay the tab out wide and load it again. Checked after the
// page loads because the window can report wide a moment before the page takes the new size.
export async function widenIfNarrow(page) {
  if (!(await loadedNarrow(page))) return false;
  await ensureWide(page);
  if (await loadedNarrow(page)) await page.setViewportSize(WIDE).catch(() => {});
  log('Recruiter came up in its narrow layout; loading it again wide');
  await goto(page, page.url());
  return true;
}

// `report` feeds the page's search panel as the pages come in (see sweeps.js).
// `boolean` and `tag` run it as Search 2 (tag 's2'); Search 1 is the role's own boolean (tag 's1').
// Each person is marked with the search that found them (lead.foundBy). `seen` collects this
// search's people and `other` is the other search's, so the overlap can be counted.
export async function runRecruiterSearch(page, store, cfg, { maxPages, report = () => {}, boolean = null, tag = 's1', seen: seenSet = null, other = null, excludedSet = new Set() } = {}) {
  const role = cfg.role;
  if (!(boolean || role?.boolean)) throw new Error('The role has no boolean search yet.');
  // what Kai's excludes taught: left out of both searches (see excludelearn.js)
  store.refresh();                                 // excludes made in the app a moment ago count
  const learned = learnedFor(store, cfg);
  const query = withLearnedNot(boolean || role.boolean, learned);
  if (learned.length) log(`search ${tag === 's2' ? 2 : 1} also leaves out, learned from your excludes:`, learned.map(x => x.term).join(', '));
  await ensureWide(page);                          // a narrow window hides the box and the filters
  await goto(page, SEARCH_URL);
  await widenIfNarrow(page);
  if (!/\/talent\//.test(page.url())) throw new Error(`Recruiter did not open (landed on ${page.url()}). Press Log in to Recruiter.`);

  const box = await openSearchBox(page);
  if (!box) {
    // The page itself is kept as well as the picture, so the next fix is made from the real markup.
    await snap(page, 'recruiter-no-search-box'); await saveDom(page, 'recruiter-no-search-box');
    throw new Error('Recruiter search box not found');
  }
  await box.click(); await sleep(randomBetween(500, 900));
  await box.fill('');
  await typeLikeHuman(box, query);
  await sleep(randomBetween(800, 1400));
  const before = await firstHref(page);          // rows from an earlier search must not be read
  await page.keyboard.press('Enter');
  log(`recruiter search${tag === 's2' ? ' 2' : ''}:`, query);
  await waitForResults(page, 20000, before);
  if (!searchLocations(role).length) log('unrestricted location: Recruiter searches worldwide');

  // Without the location the list would be people from anywhere, so a location that will not apply stops the search.
  const locs = searchLocations(role);
  let placed = 0;
  for (const loc of locs) if (await addFacet(page, 'location', loc)) placed++;
  if (locs.length && !placed) throw new Error(`Recruiter would not take the location "${locs.join(', ')}". Nothing saved. Check the role's location with Edit role.`);
  for (const skill of recruiterSkills(role)) await addFacet(page, 'skill', skill);

  const pages = maxPages || cfg.maxSearchPages || 5;
  let added = 0, seen = 0, excluded = 0, overlap = 0;
  const overlapSet = new Set();
  for (let p = 1; p <= pages; p++) {
    if (!(await waitForResults(page))) { if (p === 1) { await snap(page, 'recruiter-no-results'); warn('Recruiter found nobody for this search and location. Loosen it with Edit search.'); } break; }
    // results load as you scroll
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, randomBetween(600, 1100)); await sleep(randomBetween(350, 800)); }
    const rows = await readRecruiterResults(page);
    seen += rows.length;
    store.refresh();          // pick up approvals and exclusions made in the app while this search ran
    const got = fileRecruiterRows(store, cfg, rows, { tag, seen: seenSet, other, locs, excludedSet, overlapSet });
    const fresh = got.fresh;
    excluded = got.excluded; overlap = got.overlap;
    added += fresh;
    store.save();
    log(`recruiter page ${p}: ${rows.length} people, ${fresh} new`);
    report({ page: p, seen, added, excluded, overlap });
    if (p < pages && !(await nextPage(page, p + 1))) break;
    await sleep(humanPauseMs([6, 15]));
  }
  log(`recruiter search${tag === 's2' ? ' 2' : ''} done: ${added} new people (${seen} seen${excluded ? `, ${excluded} you excluded left out` : ''}) in "${cfg.name}"`);
  report({ seen, added, excluded, overlap });
  return added;
}

// Files one page of Recruiter results for a role. Pure: no browser, so it is tested directly.
// Each person is marked with the search that found them (lead.foundBy: 's1', 's2'); someone already
// in the role under their /in/ address is never filed twice, and never comes back into To approve
// if Kai excluded them or they have been contacted (24 Sep 2026).
// `excludedSet` and `overlapSet` are shared across pages and both searches, so each person counts once.
export function fileRecruiterRows(store, cfg, rows, { tag = 's1', seen = null, other = null, locs = [], excludedSet = new Set(), overlapSet = new Set() } = {}) {
  let fresh = 0;
  const mark = lead => {
    if (!lead || lead.campaign !== cfg.name) return;
    if (!(lead.foundBy || []).includes(tag)) lead.foundBy = [...(lead.foundBy || []), tag];
    if (seen) seen.add(lead.url);
    if (other && other.has(lead.url)) overlapSet.add(lead.url);
  };
  const leftOut = lead => { if (lead.skippedByHand && lead.campaign === cfg.name) excludedSet.add(lead.url); };
  for (const r of rows) {
    if (!r.recruiterUrl) continue;
    const known = store.findByRecruiterUrl(r.recruiterUrl);
    if (known) { leftOut(known); mark(known); continue; }
    const gone = store.excludedTwin(cfg.name, r.name);
    if (gone) { leftOut(gone); continue; }
    const twin = store.findTwin(cfg.name, r.name, r.company);
    if (twin) { leftOut(twin); if (twin.status === 'new') mark(twin); continue; }
    const lead = store.upsertLead({ url: r.recruiterUrl, name: r.name, headline: r.headline, location: r.location, degree: r.degree, company: r.company || '', companyUrl: r.companyUrl || '', sector: r.industry || '', tenureText: r.tenureText || '', tenureMonths: tenureMonths(r.tenureText), currentTitle: r.currentTitle || '', experienceMonths: experienceMonths(r.history), historyTruncated: !!r.historyTruncated, campaign: cfg.name, notes: r.industry ? `industry: ${r.industry}` : '' });
    mark(lead);
    if (outsideArea(r.location, locs)) store.setStatus(lead.url, 'skipped', { error: `outside ${locs.join(' / ')} (${r.location})` });
    fresh++;
  }
  return { fresh, excluded: excludedSet.size, overlap: overlapSet.size };
}

// Opens a Recruiter profile and reads the person's normal /in/ address from it.
export async function publicUrlFor(page, recruiterUrl) {
  await goto(page, recruiterUrl);
  const a = await firstVisible(page, SEL.recruiterPublicProfile, 8000);
  const href = a ? await a.getAttribute('href') : null;
  const url = normalizeUrl(href);
  if (!url || !/\/in\//.test(url)) { await snap(page, 'recruiter-no-public-url'); return null; }
  return url;
}
