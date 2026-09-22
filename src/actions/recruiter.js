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

async function waitForResults(page, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await page.locator(SEL.recruiterResultItem.join(', ')).count()) return true;
    if (await page.locator('text=/No results|didn.t find any|Try removing/i').count()) return false;
    await sleep(700);
  }
  return false;
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
        degree,
      });
    }
    return out;
  }, SEL.recruiterResultItem.join(', '));
}

// Opens a left-panel filter (Locations, Skills), types the value and picks the first suggestion.
async function addFacet(page, buttonSel, value, what) {
  const btn = await firstVisible(page, buttonSel, 5000);
  if (!btn) { await snap(page, `recruiter-no-${what}-button`); warn(`could not find the Recruiter ${what} filter`); return false; }
  await btn.click();
  await sleep(randomBetween(600, 1100));
  const input = await firstVisible(page, SEL.recruiterFacetInput, 3000);
  if (!input) { await snap(page, `recruiter-no-${what}-input`); return false; }
  await typeLikeHuman(input, value);
  await sleep(randomBetween(1200, 2000));
  const opt = await firstVisible(page, SEL.recruiterFacetOption, 5000);
  if (opt) {
    const label = (await opt.innerText().catch(() => '')).split('\n')[0].trim();
    await opt.click();
    log(`recruiter ${what}: ${value} -> ${label || '(first match)'}`);
  } else {
    await page.keyboard.press('ArrowDown'); await sleep(300); await page.keyboard.press('Enter');
    log(`recruiter ${what}: ${value} (picked with the keyboard)`);
  }
  await sleep(randomBetween(2000, 3500));
  return true;
}

// At most two skills: more than that narrows Recruiter too far.
export function recruiterSkills(role) {
  return [...new Set((role?.recruiterSkills || []).map(s => String(s).trim()).filter(Boolean))].slice(0, 2);
}

async function nextPage(page, pageNo) {
  const before = page.url();
  const next = await firstVisible(page, SEL.recruiterNextPage, 1500);
  if (next) { await next.click(); }
  else {
    const link = page.locator('li[data-test-pagination-link]', { hasText: new RegExp(`^\\s*${pageNo}\\b`) }).first();
    if (!(await link.count())) return false;
    await link.click();
  }
  await sleep(randomBetween(2500, 4000));
  await guard(page);
  return page.url() !== before || await waitForResults(page, 8000);
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
  await page.keyboard.press('Enter');
  log('recruiter search:', role.boolean);
  await waitForResults(page);

  for (const loc of searchLocations(role)) await addFacet(page, SEL.recruiterAddLocation, loc, 'location');
  for (const skill of recruiterSkills(role)) await addFacet(page, SEL.recruiterAddSkill, skill, 'skill');

  const pages = maxPages || cfg.maxSearchPages || 5;
  let added = 0, seen = 0;
  for (let p = 1; p <= pages; p++) {
    if (!(await waitForResults(page))) { if (p === 1) { await snap(page, 'recruiter-no-results'); warn('Recruiter found nobody for this search and location. Loosen it with Edit search.'); } break; }
    // results load as you scroll
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, randomBetween(600, 1100)); await sleep(randomBetween(350, 800)); }
    const rows = await readRecruiterResults(page);
    seen += rows.length;
    let fresh = 0;
    for (const r of rows) {
      if (!r.recruiterUrl || store.findByRecruiterUrl(r.recruiterUrl)) continue;
      store.upsertLead({ url: r.recruiterUrl, name: r.name, headline: r.headline, location: r.location, degree: r.degree, company: '', campaign: cfg.name, notes: r.industry ? `industry: ${r.industry}` : '' });
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
