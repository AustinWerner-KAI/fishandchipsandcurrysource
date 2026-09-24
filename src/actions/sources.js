// The other places a good engineer leaves a trace: GitHub, npm, crates.io, the EIP and ERC
// repositories, Stack Exchange, Sherlock, HackerOne, Trail of Bits. Pressing Search runs these
// as well as LinkedIn.
//
// Two rules shape everything here, and neither is negotiable:
//   1. Only the sources the registry marks `auto` are ever fetched. The rest are listed for Kai
//      to look at by hand, or never touched at all.
//   2. No address is ever collected or used. GitHub's own policy forbids using what is on GitHub
//      for "sending unsolicited emails to users or selling personal information, such as to
//      recruiters, headhunters, and job boards", so these sites are used to FIND and CHECK
//      people. The way to reach somebody is still their LinkedIn profile.
import { searchPublic } from '../sources/search.js';
import { automated } from '../sources/registry.js';
import { scrubEmails } from '../sources/shape.js';
import { collectSearchResults } from '../linkedin.js';
import { buildSearchUrl } from '../role.js';
import { remaining, humanPauseMs, sleep, ACCOUNT_TZ } from '../limits.js';
import { stopRequested } from '../stop.js';
import { log, warn } from '../log.js';

// What to look for. The role's own skills and domain words describe the work; the job title does
// not, because nobody writes "Senior Cloud Security Engineer" in a commit.
export function termsForRole(cfg) {
  const r = cfg?.role || {};
  const terms = [...(r.skills || []), ...(r.recruiterSkills || []), ...(r.domain || [])]
    .map(t => String(t || '').trim())
    .filter(t => t.length > 2);
  return [...new Set(terms.map(t => t.toLowerCase()))].slice(0, 6);
}

// One key per human. GitHub handle when we have it, because that is the one identifier these
// sites agree on; otherwise the site and the handle it knew them by.
export function findKey(person) {
  const gh = String(person?.github || '').trim().toLowerCase();
  if (gh) return `github:${gh}`;
  const src = (person?.sources || [])[0] || 'unknown';
  const h = String(person?.handle || person?.name || '').trim().toLowerCase();
  return h ? `${src}:${h}` : '';
}

// Is this the person we went looking for? A full name has to match properly: "Sam Lee" must not
// come back as "Samantha Leeming", and one wrong match here means contacting a stranger.
export function sameHuman(wanted, found) {
  const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
  const a = norm(wanted), b = norm(found);
  if (!a || !b) return false;
  if (a === b) return true;
  const aw = a.split(' '), bw = b.split(' ');
  if (aw.length < 2 || bw.length < 2) return false;
  // first and last both present, in order, whole words: allows a middle name, refuses a prefix
  return aw[0] === bw[0] && aw[aw.length - 1] === bw[bw.length - 1];
}

// Looks one person up on LinkedIn by name, so somebody found on GitHub can be approached the
// normal way. Returns { url, row } only when exactly one person there answers to that name.
export async function lookupOnLinkedIn(page, person, { collect = collectSearchResults } = {}) {
  const name = String(person?.name || '').trim();
  if (!name || name.split(/\s+/).length < 2) return { outcome: 'no-name' };
  const words = [`"${name}"`, person.company ? `"${person.company}"` : ''].filter(Boolean).join(' ');
  const url = buildSearchUrl(words, []);
  let rows = [];
  try { rows = await collect(page, url, 1); }
  catch (e) {
    if (e.name === 'CheckpointError' || e.name === 'NotLoggedInError') throw e;
    warn(`sources: could not look up ${name} on LinkedIn:`, e.message.slice(0, 90));
    return { outcome: 'lookup-failed' };
  }
  const hits = rows.filter(r => sameHuman(name, r.name));
  if (!hits.length) return { outcome: 'no-match' };
  // Two people with the same name is the normal case for common names. Guessing between them is
  // how a stranger gets contacted, so it stops and says so.
  if (hits.length > 1) return { outcome: 'ambiguous' };
  return { outcome: 'matched', url: `https://www.linkedin.com/in/${hits[0].slug}/`, row: hits[0] };
}

// Runs the allowed public sources for this role, files everyone found, then looks up the
// strongest few on LinkedIn so they join the normal list.
export async function runSources(page, store, cfg, { maxLookups = 8, search = searchPublic, lookup = lookupOnLinkedIn, pause = true } = {}) {
  const terms = termsForRole(cfg);
  if (!terms.length) { log('sources: this role has no skills or industry words to search for, so only LinkedIn was searched'); return { found: 0, matched: 0 }; }
  const ids = automated().filter(s => s.role === 'discovery').map(s => s.id);
  log(`sources: looking for ${terms.join(', ')} across ${ids.join(', ')}`);

  let people = [];
  try { people = await search({ terms, location: cfg.role?.location || '' }); }
  catch (e) { warn('sources: the public search failed, carrying on with LinkedIn only:', e.message.slice(0, 140)); return { found: 0, matched: 0 }; }

  store.refresh();
  let fresh = 0;
  for (const p of people) {
    const key = findKey(p);
    if (!key) continue;
    const before = !!store.data.finds[key];
    store.upsertFind(key, {
      name: p.name || '', github: p.github || '', company: p.company || '', location: p.location || '',
      url: p.url || (p.github ? `https://github.com/${p.github}` : ''),
      sources: p.sources || [], weight: p.weight ?? 0, lastActiveAt: p.lastActiveAt || null,
      campaign: cfg.name,
      // scrubbed on the way in as well as at the source: no address is ever written down
      evidence: (p.evidence || []).slice(0, 8).map(e => ({ label: scrubEmails(e.label), value: scrubEmails(e.value) })),
    });
    if (!before) fresh++;
  }
  store.save();
  log(`sources: ${people.length} people, ${fresh} of them new`);

  // The strongest first, and only the ones we have not already tried to place.
  const queue = store.findRows(cfg.name)
    .filter(f => !f.lookedUpAt && f.name && f.name.split(/\s+/).length >= 2)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0) || String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')));

  let matched = 0, looked = 0;
  for (const f of queue) {
    if (looked >= maxLookups || stopRequested()) break;
    if (remaining(store, cfg.dailyCaps, 'profileViews', new Date(), ACCOUNT_TZ) <= 0) { log('sources: profile view cap reached, the rest wait for the next search'); break; }
    const r = await lookup(page, f);
    looked++;
    store.refresh();
    store.recordAction('profileViews', f.key);
    const row = store.data.finds[f.key];
    if (row) { row.lookedUpAt = new Date().toISOString(); row.outcome = r.outcome; }
    if (r.outcome === 'matched') {
      const existing = store.get(r.url);
      if (existing) { if (row) row.outcome = 'already-on-file'; }
      else {
        store.upsertLead({
          url: r.url, name: r.row.name, headline: r.row.headline, location: r.row.location,
          degree: r.row.degree, campaign: cfg.name,
          notes: `found on ${(f.sources || []).join(', ')}${f.github ? ` (github/${f.github})` : ''}`,
        });
        matched++;
      }
      if (row) row.matchedUrl = r.url;
    }
    store.save();
    if (pause) await sleep(humanPauseMs([8, 20]));
  }
  log(`sources: looked up ${looked}, added ${matched} to the list for "${cfg.name}"`);
  return { found: people.length, fresh, matched, looked };
}
