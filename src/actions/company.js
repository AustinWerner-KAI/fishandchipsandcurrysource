// Reads a company's LinkedIn page once to learn its sector and headcount, then remembers it.
// Employers repeat across a search, so twenty lookups usually cover a hundred people.
// Company pages are not candidate profiles: they cost no profile view and nobody is contacted here.
import { goto, guard, saveDom } from '../browser.js';
import { log, warn } from '../log.js';
import { sleep, randomBetween, pauseFor, humanPauseMs } from '../limits.js';
import { stopRequested } from '../stop.js';
import { companyKey, parseCompanyAbout } from '../company.js';

// LinkedIn's own company search. One page, then the About tab of the first result.
const searchUrl = name => `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(name)}`;
const aboutUrl = slugOrUrl => {
  const slug = String(slugOrUrl).match(/\/company\/([^/?#]+)/)?.[1] || slugOrUrl;
  return `https://www.linkedin.com/company/${slug}/about/`;
};

// The first /company/ link on a company search page, or null when nothing matched.
export async function findCompanyPage(page, name) {
  await goto(page, searchUrl(name));
  await sleep(randomBetween(900, 1800));
  const href = await page.evaluate(() => {
    const a = [...document.querySelectorAll('main a[href*="/company/"]')]
      .find(x => /\/company\/[^/?#]+/.test(x.getAttribute('href') || ''));
    return a ? a.href.split('?')[0] : '';
  }).catch(() => '');
  return href || null;
}

// Sector and headcount from a company's About tab. Returns null when the page did not load as one.
export async function readCompanyAbout(page, slugOrUrl) {
  await goto(page, aboutUrl(slugOrUrl));
  await guard(page);
  const text = await page.evaluate(() => (document.querySelector('main')?.innerText || '')).catch(() => '');
  const parsed = parseCompanyAbout(text);
  if (!parsed.sector && !parsed.size) { await saveDom(page, 'company-about-unreadable'); return null; }
  return parsed;
}

// Looks up the employers we do not know yet, commonest first.
// A company that cannot be found is counted as a miss and dropped after three tries,
// so one odd company name never holds the pass up forever.
export async function runCompanyLookups(page, store, cfg, { max = 8, ops = { findCompanyPage, readCompanyAbout }, pause = true } = {}) {
  store.load();
  const wanted = store.companiesToLookUp({ campaign: cfg.name }).slice(0, max);
  if (!wanted.length) { log('companies: nothing new to look up'); return { read: 0 }; }

  let read = 0;
  for (const c of wanted) {
    if (stopRequested()) break;
    let url = c.url;
    try {
      if (!url) url = await ops.findCompanyPage(page, c.name);
      if (!url) {
        store.refresh();
        for (const k of (c.keys || [c.key])) store.countMiss(k, c.name);
        store.save();
        warn(`companies: could not find a page for "${c.name}"`);
        if (pause) await pauseFor(humanPauseMs([10, 30]));
        continue;
      }
      const about = await ops.readCompanyAbout(page, url);
      store.refresh();
      if (!about) {
        // counted against the key the queue uses, not the page we happened to land on,
        // or the miss never sticks and the company is fetched again every single pass
        for (const k of (c.keys || [c.key])) store.countMiss(k, c.name);
        store.save();
        warn(`companies: the page for "${c.name}" did not read as a company page`);
      } else {
        // Keyed on the page URL when we have one, and on the name too, so both spellings find it.
        const facts = { name: c.name, url, sector: about.sector, size: about.size, sizeText: about.sizeText, misses: 0 };
        // written under every name this employer is known by, so neither spelling is fetched again
        for (const k of new Set([...(c.keys || [c.key]), companyKey(url), companyKey(c.name)].filter(Boolean))) store.setCompanyAt(k, facts);
        store.save();
        read++;
        log(`companies: ${c.name} — ${about.sector || 'sector unknown'}, ${about.sizeText || 'size unknown'} (${c.people} ${c.people === 1 ? 'person' : 'people'})`);
      }
    } catch (e) {
      if (e.name === 'CheckpointError' || e.name === 'NotLoggedInError') throw e;
      warn('companies: lookup failed for', c.name, e.message);
    }
    if (pause) await pauseFor(humanPauseMs([15, 45]));
  }
  return { read };
}
