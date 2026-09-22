// Search in Recruiter Lite with the role's boolean and locations, and collect the people.
// Recruiter results link only to Recruiter profiles (/talent/profile/<id>); the person's normal
// /in/ address is looked up later, only for people Kai approves (see publicUrlFor).
import { goto, snap, guard, typeLikeHuman } from '../browser.js';
import { SEL, firstVisible } from '../selectors.js';
import { log, warn } from '../log.js';
import { sleep, randomBetween, humanPauseMs } from '../limits.js';
import { searchLocations } from './search.js';
import { normalizeUrl } from '../store.js';

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
        degree,
      });
    }
    return out;
  }, SEL.recruiterResultItem.join(', '));
}

// Opens a left-panel filter (Locations, Skills), types the value and picks the matching suggestion.
// The text box is the first one AFTER the filter's own + button, so a box left open by another
// filter (Locations) is never typed into, and a suggestion must contain the value typed:
// "Azure" never becomes "Vermont, United States".
export async function addFacet(page, buttonSel, value, what) {
  await closeFacets(page);
  const btn = await firstVisible(page, buttonSel, 5000);
  if (!btn) { await snap(page, `recruiter-no-${what}-button`); warn(`could not find the Recruiter ${what} filter`); return false; }
  await btn.click();
  await sleep(randomBetween(600, 1100));
  const handle = await btn.evaluateHandle(el => {
    const ok = i => i.type !== 'hidden' && i.id !== 'system-search-typeahead' && !/^Search by job title/.test(i.getAttribute('aria-label') || '') && i.offsetParent !== null;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const after = [...a.querySelectorAll('input[type="text"], input:not([type]), input[role="combobox"]')]
        .filter(i => ok(i) && (el.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (after.length) {
        document.querySelectorAll('[data-sourcer-facet]').forEach(x => x.removeAttribute('data-sourcer-facet'));
        after[0].setAttribute('data-sourcer-facet', '1');
        return true;
      }
    }
    return false;
  });
  const input = (await handle.jsonValue()) ? page.locator('[data-sourcer-facet="1"]') : null;
  if (!input) { await closeFacets(page); await snap(page, `recruiter-no-${what}-input`); warn(`Recruiter ${what} box did not open; searching without "${value}"`); return false; }
  const before = await firstHref(page);
  await input.click();
  await typeLikeHuman(input, value);
  await sleep(randomBetween(1200, 2000));
  // the suggestion list that belongs to this box, when LinkedIn says which one it is
  const listId = await input.getAttribute('aria-controls').catch(() => null) || await input.getAttribute('aria-owns').catch(() => null);
  const scope = listId ? page.locator(`[id="${listId.replace(/"/g, '')}"]`) : page;
  const want = value.toLowerCase().split(/[ ,]+/).filter(Boolean);
  let opt = null, label = '';
  // aria-controls points at the list itself, so inside it the options are plain [role=option]
  for (const sel of listId ? ['[role="option"]', '.artdeco-typeahead__result', ...SEL.recruiterFacetOption] : SEL.recruiterFacetOption) {
    const opts = scope.locator(sel).locator('visible=true');
    const n = Math.min(await opts.count().catch(() => 0), 8);
    for (let i = 0; i < n && !opt; i++) {
      const text = ((await opts.nth(i).innerText().catch(() => '')).split('\n')[0] || '').trim();
      if (want.every(w => text.toLowerCase().includes(w))) { opt = opts.nth(i); label = text; }
    }
    if (opt) break;
  }
  if (!opt) {
    await closeFacets(page);
    await snap(page, `recruiter-no-${what}-match`);
    warn(`Recruiter had no ${what} matching "${value}"; searching without it`);
    return false;
  }
  await opt.click();
  log(`recruiter ${what}: ${value} -> ${label}`);
  const changed = await waitForResults(page, 12000, before);
  // the same person can still be first after a filter, so an unchanged list is fine when the chip shows
  const chip = await page.getByText(label, { exact: false }).locator('visible=true').count().catch(() => 0);
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

export async function runRecruiterSearch(page, store, cfg, { maxPages } = {}) {
  const role = cfg.role;
  if (!role?.boolean) throw new Error('The role has no boolean search yet.');
  await goto(page, SEARCH_URL);
  if (!/\/talent\//.test(page.url())) throw new Error(`Recruiter did not open (landed on ${page.url()}). Press Log in to Recruiter.`);

  const box = await firstVisible(page, SEL.recruiterSearchBox, 8000);
  if (!box) { await snap(page, 'recruiter-no-search-box'); throw new Error('Recruiter search box not found'); }
  await box.click(); await sleep(randomBetween(500, 900));
  await box.fill('');
  await typeLikeHuman(box, role.boolean);
  await sleep(randomBetween(800, 1400));
  const before = await firstHref(page);          // rows from an earlier search must not be read
  await page.keyboard.press('Enter');
  log('recruiter search:', role.boolean);
  await waitForResults(page, 20000, before);
  if (!searchLocations(role).length) warn('this role has no location, so Recruiter searches everywhere');

  // Without the location the list would be people from anywhere, so a location that will not apply stops the search.
  const locs = searchLocations(role);
  let placed = 0;
  for (const loc of locs) if (await addFacet(page, SEL.recruiterAddLocation, loc, 'location')) placed++;
  if (locs.length && !placed) throw new Error(`Recruiter would not take the location "${locs.join(', ')}". Nothing saved. Check the role's location with Edit role.`);
  for (const skill of recruiterSkills(role)) await addFacet(page, SEL.recruiterAddSkill, skill, 'skill');

  const pages = maxPages || cfg.maxSearchPages || 5;
  let added = 0, seen = 0;
  for (let p = 1; p <= pages; p++) {
    if (!(await waitForResults(page))) { if (p === 1) { await snap(page, 'recruiter-no-results'); warn('Recruiter found nobody for this search and location. Loosen it with Edit search.'); } break; }
    // results load as you scroll
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, randomBetween(600, 1100)); await sleep(randomBetween(350, 800)); }
    const rows = await readRecruiterResults(page);
    seen += rows.length;
    store.refresh();          // pick up approvals and exclusions made in the app while this search ran
    let fresh = 0;
    for (const r of rows) {
      if (!r.recruiterUrl || store.findByRecruiterUrl(r.recruiterUrl)) continue;
      const lead = store.upsertLead({ url: r.recruiterUrl, name: r.name, headline: r.headline, location: r.location, degree: r.degree, company: r.company || '', campaign: cfg.name, notes: r.industry ? `industry: ${r.industry}` : '' });
      if (outsideArea(r.location, locs)) store.setStatus(lead.url, 'skipped', { error: `outside ${locs.join(' / ')} (${r.location})` });
      fresh++;
    }
    added += fresh;
    store.save();
    log(`recruiter page ${p}: ${rows.length} people, ${fresh} new`);
    if (p < pages && !(await nextPage(page, p + 1))) break;
    await sleep(humanPauseMs([6, 15]));
  }
  log(`recruiter search done: ${added} new people (${seen} seen) in "${cfg.name}"`);
  return added;
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
