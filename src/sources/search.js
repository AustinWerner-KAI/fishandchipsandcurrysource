// One search across every public source we are allowed to fetch.
//
// It runs in two passes. The first finds people. The second takes the handles the first pass
// turned up and asks the sources that are good at identity who those handles belong to, which is
// what turns a pseudonym into someone we can actually approach. A source that fails, times out or
// rate limits is reported and skipped; it never stops the rest.
import { mergeFinds } from './merge.js';
import { automated, manualOnly, byId } from './registry.js';
import { searchEips } from './eips.js';
import { searchStackExchange, SITES } from './stackexchange.js';
import { searchSherlock } from './sherlock.js';
import { searchNpm } from './npm.js';
import { searchCrates, lookupCrates } from './crates.js';
import { searchGitHub, lookupGitHub } from './github.js';
import { lookupHackerOne } from './hackerone.js';
import { log, warn } from '../log.js';

// Which Stack Exchange sites are worth asking for a given subject.
const siteFor = terms => {
  const t = terms.join(' ').toLowerCase();
  const sites = [];
  if (/solidity|ethereum|evm|smart contract|web3|defi/.test(t)) sites.push('ethereum');
  if (/bitcoin|lightning|utxo/.test(t)) sites.push('bitcoin');
  if (/quant|trading|derivativ|pricing/.test(t)) sites.push('quant');
  if (!sites.length || /security|crypto|appsec|pentest|threat/.test(t)) sites.push('security');
  return [...new Set(sites)];
};

export const DISCOVERY = {
  eips: ({ terms, since, ops }) => ops.searchEips({ match: terms[0] || '', since }),
  stackexchange: async ({ terms, ops }) => {
    const out = [];
    for (const site of siteFor(terms)) {
      for (const tag of terms.slice(0, 2)) {
        out.push(...await ops.searchStackExchange({ tag, site, period: 'all_time' }));
      }
    }
    return out;
  },
  sherlock: ({ ops }) => ops.searchSherlock({ seniorOnly: true }),
  npm: ({ terms, ops }) => ops.searchNpm({ text: `keywords:${terms[0] || ''}` }),
  crates: ({ terms, ops }) => ops.searchCrates({ q: terms[0] || '', max: 12 }),
  github: ({ terms, location, ops }) => ops.searchGitHub({
    q: [terms.join(' '), location ? `location:${JSON.stringify(location)}` : '', 'repos:>5'].filter(Boolean).join(' '),
    max: 20,
  }),
};

const DEFAULT_OPS = { searchEips, searchStackExchange, searchSherlock, searchNpm, searchCrates, searchGitHub, lookupGitHub, lookupHackerOne, lookupCrates };

export async function searchPublic({
  terms = [], location = '', since = null,
  sources = automated().filter(s => s.role === 'discovery').map(s => s.id),
  enrich = true, ops = DEFAULT_OPS, onProgress = () => {},
} = {}) {
  const wanted = terms.filter(Boolean);
  if (!wanted.length) throw new Error('Give the search at least one subject, such as "solidity" or "cloud security"');

  const finds = [], problems = [];
  for (const id of sources) {
    const run = Object.hasOwn(DISCOVERY, id) ? DISCOVERY[id] : null;
    if (!run) { problems.push({ source: id, problem: 'no adapter' }); continue; }
    onProgress(id, { state: 'running' });
    try {
      const got = await run({ terms: wanted, location, since, ops });
      finds.push(...got);
      log(`sources: ${id} gave ${got.length}`);
      // GitHub without a token answers, but only 10 searches an hour, so a 0 there is not "nobody"
      const limited = id === 'github' && !process.env.GITHUB_TOKEN;
      onProgress(id, { state: limited ? 'limited' : 'done', count: got.length, ...(limited ? { problem: 'No GitHub token, so only 10 searches an hour.' } : {}) });
    } catch (e) {
      problems.push({ source: id, problem: e.message.slice(0, 140), rateLimited: !!e.rateLimited });
      warn(`sources: ${id} failed, carrying on:`, e.message.slice(0, 140));
      onProgress(id, { state: e.rateLimited ? 'limited' : 'failed', count: 0, problem: e.message.slice(0, 140) });
    }
  }

  let people = mergeFinds(finds);
  if (enrich) {
    onProgress('names', { state: 'running' });
    const extra = await enrichPeople(people, { ops, problems });
    people = mergeFinds([...finds, ...extra]);
    onProgress('names', { state: 'done', count: extra.length });
  }

  // Anyone the sources only know as a handle is a dead end until we can name them; say so rather
  // than quietly dropping them, because some of the best auditors are pseudonymous on purpose.
  const named = people.filter(p => p.name);
  log(`sources: ${people.length} people, ${named.length} with a real name, from ${sources.length - problems.length} of ${sources.length} sites`);
  return { people, problems, manual: manualOnly().map(s => ({ id: s.id, title: s.title, url: s.url, note: s.note })) };
}

// The identity pass.
//
// A pseudonym on one site and the same string on another are not the same person: handles collide
// constantly. So a lookup only joins the two records when something OTHER than the handle agrees
// as well. Without that it is kept as a separate suggestion, which is honest, rather than welded
// on, which quietly invents a person who does not exist.
export function corroborates(person, found) {
  if (!person || !found) return false;
  const same = (a, b) => a && b && String(a).toLowerCase() === String(b).toLowerCase();
  if (same(person.twitter, found.twitter)) return true;
  if (same(person.github, found.github)) return true;
  if (person.email && found.email && same(person.email, found.email)) return true;
  // their real name already showing up somewhere in what the other sites said about them
  if (found.name && person.evidence.some(e => String(e.value).toLowerCase().includes(found.name.toLowerCase()))) return true;
  return false;
}

export async function enrichPeople(people, { ops = DEFAULT_OPS, problems = [], max = 25 } = {}) {
  const out = [];
  const needName = (people || []).filter(p => !p.name).slice(0, max);
  for (const p of needName) {
    const first = src => (p.handles[src] || [])[0] || '';
    const h = first('sherlock') || first('hackerone') || p.twitter || first('crates');
    if (!h) continue;
    // everything we already know them by, offered only if the lookup turns out to be them
    const aliases = Object.entries(p.handles)
      .flatMap(([source, list]) => (list || []).map(handle => ({ source, handle })));
    let found = null;
    try { found = await ops.lookupHackerOne({ handle: h }); }
    catch (e) { problems.push({ source: 'hackerone', problem: e.message.slice(0, 120), rateLimited: !!e.rateLimited }); }
    if (!found) {
      try { found = await ops.lookupCrates({ handle: h }); }
      catch { /* a miss here is normal, not a problem worth reporting */ }
    }
    if (!found) continue;
    if (corroborates(p, found)) out.push({ ...found, aliases: [...(found.aliases || []), ...aliases] });
    else out.push({ ...found, evidence: [...(found.evidence || []), { label: 'possibly the same person as', value: `${h} on ${p.sources.join(' and ')}, unconfirmed` }] });
  }

  // Fill in what GitHub knows about anyone we only have a handle for. A GitHub handle is already
  // a hard key, so this one can be joined safely.
  const needDetail = (people || []).filter(p => p.github && !p.location && !p.company).slice(0, max);
  for (const p of needDetail) {
    try {
      const g = await ops.lookupGitHub({ handle: p.github });
      if (g) out.push(g);
    } catch (e) { problems.push({ source: 'github', problem: e.message.slice(0, 120), rateLimited: !!e.rateLimited }); break; }
  }
  return out;
}

export { SITES, byId };
