import { collectSearchResults } from '../linkedin.js';
import { log } from '../log.js';
import { sleep, humanPauseMs } from '../limits.js';

export async function runSearch(page, store, cfg, { url, maxPages } = {}) {
  const searchUrl = url || cfg.searchUrl;
  if (!searchUrl) throw new Error('No search URL. Put one in the campaign file as "searchUrl" or pass it on the command line.');
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
