import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const { readSweeps, sweepStart, sweepStep, sweepSet, sweepEnd, sweepForget } = await import('../src/sweeps.js');
const { findsFor, legacyFoundOn } = await import('../src/app.js');
const { Store } = await import('../src/store.js');
const { searchAndSweep } = await import('../src/actions/search.js');
const { runSources } = await import('../src/actions/sources.js');
const { searchPublic } = await import('../src/sources/search.js');

const cfg = {
  name: 'c1', role: { title: 'Senior Cloud Security Engineer', location: 'Dubai', skills: ['cloud security'], domain: ['crypto'] },
  dailyCaps: { connects: 10, messages: 10, profileViews: 60 },
};
const fresh = () => { const s = new Store(path.join(home, `db-${Math.random()}.json`)); s.save(); return s; };

// ---- the progress file -------------------------------------------------------------------------
test('a search is written down site by site, one row per role, newest search only', () => {
  sweepStart('c1');
  sweepStep('c1', 'recruiter', { state: 'running' });
  sweepStep('c1', 'recruiter', { page: 2, seen: 40, added: 3 });
  sweepStep('c1', 'recruiter', { state: 'done', added: 5 });
  sweepSet('c1', { terms: ['cloud'] });
  sweepEnd('c1');
  const w = readSweeps().c1;
  assert.equal(w.state, 'done');
  assert.ok(w.finishedAt);
  assert.deepEqual(w.terms, ['cloud']);
  assert.equal(w.steps.recruiter.state, 'done');
  assert.equal(w.steps.recruiter.seen, 40, 'a later patch keeps what an earlier one said');
  assert.equal(w.steps.recruiter.added, 5);
  sweepStart('c1');
  assert.deepEqual(readSweeps().c1.steps, {}, 'a new search starts a clean row');
});

test('a broken progress file never stops a search, and reads as nothing', () => {
  fs.writeFileSync(path.join(home, 'sweeps.json'), '{not json');
  assert.deepEqual(readSweeps(), {});
  assert.doesNotThrow(() => sweepStep('c1', 'npm', { state: 'done', count: 3 }));
  assert.equal(readSweeps().c1.steps.npm.count, 3, 'and the next write starts it again cleanly');
  assert.doesNotThrow(() => sweepStep('', 'npm', {}), 'no role, nothing written, no error');
});

// ---- what searchAndSweep writes ---------------------------------------------------------------
test('a role Search writes Recruiter\'s progress, then the sweep\'s, then done', async () => {
  const seen = [];
  const search = async (page, store, c, { report }) => { report({ page: 1, seen: 18, added: 2 }); seen.push(readSweeps().c1.steps.recruiter.state); return 2; };
  const sweep = async (page, store, c, { progress }) => { progress.step('npm', { state: 'done', count: 7 }); progress.set({ funnel: { found: 7 } }); };
  await searchAndSweep(null, null, cfg, { search, sweep });
  const w = readSweeps().c1;
  assert.deepEqual(seen, ['running'], 'Recruiter shows as running while it searches');
  assert.equal(w.state, 'done');
  assert.deepEqual([w.steps.recruiter.state, w.steps.recruiter.seen, w.steps.recruiter.added], ['done', 18, 2]);
  assert.equal(w.steps.npm.count, 7);
  assert.equal(w.funnel.found, 7);
});

test('a Recruiter failure is shown as failed, not left spinning', async () => {
  await assert.rejects(() => searchAndSweep(null, null, cfg, { search: async () => { throw new Error('Recruiter search box not found'); } }));
  const w = readSweeps().c1;
  assert.equal(w.state, 'failed');
  assert.equal(w.steps.recruiter.state, 'failed');
  assert.match(w.steps.recruiter.problem, /search box/);
});

test('a sweep failure marks the search failed but keeps what LinkedIn found', async () => {
  const added = await searchAndSweep(null, null, cfg, { search: async () => 4, sweep: async () => { throw new Error('boom'); } });
  assert.equal(added, 4);
  assert.equal(readSweeps().c1.state, 'failed');
  assert.equal(readSweeps().c1.steps.recruiter.state, 'done');
});

test('a one-off URL search leaves the role\'s panel alone', async () => {
  sweepStart('c1'); sweepStep('c1', 'npm', { state: 'done', count: 99 }); sweepEnd('c1');
  await searchAndSweep(null, null, cfg, { url: 'https://www.linkedin.com/search/results/people/?keywords=x', search: async () => 1 });
  assert.equal(readSweeps().c1.steps.npm.count, 99);
});

test('a role that searches normal LinkedIn is shown as LinkedIn search, not Recruiter', async () => {
  await searchAndSweep(null, null, { ...cfg, role: { ...cfg.role, source: 'linkedin' } }, { search: async () => 1, sources: false });
  const w = readSweeps().c1;
  assert.ok(w.steps.linkedin && !w.steps.recruiter);
});

// ---- what runSources reports, and what it keeps on the person -----------------------------------
test('the sweep reports each site, the funnel, and the look-ups, and marks where each person was found', async () => {
  const s = fresh();
  const steps = {}, sets = [];
  const progress = { step: (id, p) => { steps[id] = { ...(steps[id] || {}), ...p }; }, set: p => sets.push(p) };
  const search = async ({ onProgress }) => {
    onProgress('npm', { state: 'running' }); onProgress('npm', { state: 'done', count: 2 });
    return { people: [
      { name: 'Sam Lee', github: 'samlee', sources: ['npm'], weight: 9, evidence: [{ label: 'maintains', value: 'iam-kit' }] },
      { name: '', handle: 'ghost', sources: ['sherlock'], weight: 1 },
    ], problems: [] };
  };
  const lookup = async () => ({ outcome: 'matched', url: 'https://www.linkedin.com/in/sam-lee/', row: { name: 'Sam Lee', headline: 'Cloud', slug: 'sam-lee' } });
  await runSources(null, s, cfg, { search, lookup, pause: false, progress });
  assert.equal(steps.npm.state, 'done');
  assert.equal(steps.eips.state, 'waiting', 'every site starts as waiting, so the page shows them all at once');
  assert.deepEqual([steps.lookups.state, steps.lookups.looked, steps.lookups.matched], ['done', 1, 1]);
  const funnel = sets.filter(x => x.funnel).at(-1).funnel;
  assert.deepEqual(funnel, { found: 2, named: 1, fresh: 2, looked: 1, matched: 1, already: 0, waiting: 0 });
  assert.ok(sets.some(x => x.terms), 'the words it searched for are shown');
  const lead = s.get('https://www.linkedin.com/in/sam-lee/');
  assert.deepEqual(lead.foundOn.sources, ['npm']);
  assert.equal(lead.foundOn.evidence[0].value, 'iam-kit');
  assert.equal(lead.foundOn.github, 'samlee');
  assert.ok(new Store(s.file).get('https://www.linkedin.com/in/sam-lee/').foundOn, 'and it is saved, not only in memory');
});

test('someone already in People who turns up on a public source gets the source shown too', async () => {
  const s = fresh();
  s.upsertLead({ url: 'https://www.linkedin.com/in/sam-lee/', name: 'Sam Lee', campaign: 'c1' }); s.save();
  const search = async () => ({ people: [{ name: 'Sam Lee', github: 'samlee', sources: ['sherlock'], weight: 5 }] });
  const lookup = async () => ({ outcome: 'matched', url: 'https://www.linkedin.com/in/sam-lee/', row: { name: 'Sam Lee' } });
  await runSources(null, s, cfg, { search, lookup, pause: false });
  assert.deepEqual(s.get('https://www.linkedin.com/in/sam-lee/').foundOn.sources, ['sherlock']);
  assert.equal(s.data.finds['github:samlee'].outcome, 'already-on-file');
});

test('searchPublic says which site it is on, and GitHub without a token is shown as limited, not as nobody', async () => {
  const had = process.env.GITHUB_TOKEN;
  const run = async token => {
    if (token) process.env.GITHUB_TOKEN = token; else delete process.env.GITHUB_TOKEN;
    const events = [];
    const ops = { searchGitHub: async () => [] };           // GitHub answers, with nobody
    await searchPublic({ terms: ['iam'], sources: ['github'], enrich: false, ops, onProgress: (id, p) => events.push([id, p.state, p.count]) });
    return events;
  };
  try {
    assert.deepEqual(await run(''), [['github', 'running', undefined], ['github', 'limited', 0]], 'no token: limited');
    assert.deepEqual(await run('t0ken'), [['github', 'running', undefined], ['github', 'done', 0]], 'with a token, 0 really is nobody');
    const failed = [];
    await searchPublic({ terms: ['iam'], sources: ['npm'], enrich: false, ops: { searchNpm: async () => { throw new Error('npm is down'); } }, onProgress: (id, p) => failed.push([id, p.state]) });
    assert.deepEqual(failed.at(-1), ['npm', 'failed'], 'a site that breaks is shown as failed');
  } finally { if (had) process.env.GITHUB_TOKEN = had; else delete process.env.GITHUB_TOKEN; }
});

// ---- the Found elsewhere groups ---------------------------------------------------------------
test('every find lands in exactly one group, and the counts cover all of them, not just the ones shown', () => {
  const s = fresh();
  const put = (key, f) => s.upsertFind(key, { campaign: 'c1', sources: ['npm'], ...f });
  put('a', { name: 'Ann Lee', weight: 5 });                                                        // waiting
  put('a2', { name: 'Abe Lee', weight: 4 });                                                       // waiting
  put('b', { name: 'ghost', weight: 5 });                                                          // noname
  put('c', { name: 'Bo Kim', outcome: 'no-match', lookedUpAt: 'x' });                              // notfound
  put('d', { name: 'Cy Wu', outcome: 'lookup-failed', lookedUpAt: 'x' });                          // notfound
  put('e', { name: 'Di Ho', outcome: 'ambiguous', lookedUpAt: 'x' });                              // twonames
  s.upsertLead({ url: 'https://www.linkedin.com/in/eva/', name: 'Eva Ng', campaign: 'c1' });
  s.data.leads['https://www.linkedin.com/in/eva/'].approved = true;
  put('f', { name: 'Eva Ng', outcome: 'matched', lookedUpAt: 'x', matchedUrl: 'https://www.linkedin.com/in/eva/' });
  s.upsertLead({ url: 'https://www.linkedin.com/in/other/', name: 'Oli Po', campaign: 'c2' });
  put('o', { name: 'Oli Po', outcome: 'already-on-file', lookedUpAt: 'x', matchedUrl: 'https://www.linkedin.com/in/other/' });
  put('g', { name: 'Fay Li', outcome: 'matched', lookedUpAt: 'x', matchedUrl: 'https://www.linkedin.com/in/cleared/' });  // lead gone
  put('z', { name: 'Zed Other', campaign: 'c2' });                                                  // another role
  const { finds, findCounts } = findsFor(s, 'c1', 1);
  assert.deepEqual(findCounts, { waiting: 2, people: 2, twonames: 1, notfound: 2, noname: 1, removed: 1 });
  assert.equal(finds.filter(f => f.group === 'waiting').length, 1, 'each tab gets its strongest few, so no tab is ever empty while its count says otherwise');
  assert.equal(finds.filter(f => f.group === 'waiting')[0].key, 'a', 'strongest first');
  const all = findsFor(s, 'c1').finds;
  assert.equal(all.find(f => f.key === 'f').leadStatus, 'approved', 'the page can say where they are in People');
  assert.equal(all.find(f => f.key === 'f').leadRole, null);
  assert.equal(all.find(f => f.key === 'o').leadRole, 'c2', 'someone in another role\'s People is shown as that, not as in this role');
  assert.equal(all.find(f => f.key === 'g').group, 'removed', 'someone taken out of People is not shown as in People');
  assert.ok(!all.some(f => f.key === 'z'), 'another role\'s finds stay out');
});

// ---- audit round 3 -----------------------------------------------------------------------------
test('ending a search settles every step, so nothing spins or waits after the end', () => {
  sweepStart('c1');
  sweepStep('c1', 'recruiter', { state: 'done', added: 1 });
  sweepStep('c1', 'names', { state: 'running' });
  sweepStep('c1', 'npm', { state: 'waiting' });
  sweepEnd('c1', 'failed');
  const st = readSweeps().c1.steps;
  assert.deepEqual([st.recruiter.state, st.names.state, st.npm.state], ['done', 'stopped', 'skipped']);
});

test('a deleted role\'s panel goes with it', () => {
  sweepStart('gone'); sweepStart('kept');
  sweepForget('gone');
  assert.ok(!('gone' in readSweeps()) && 'kept' in readSweeps());
});

test('a public search that breaks ends the panel as failed with the reason, not as done', async () => {
  const sweep = (page, store, c, opts) => runSources(page, fresh(), c, { ...opts, search: async () => { throw new Error('npm is down'); }, pause: false });
  await searchAndSweep(null, null, cfg, { search: async () => 1, sweep });
  const w = readSweeps().c1;
  assert.equal(w.state, 'failed');
  assert.match(w.problem, /npm is down/);
});

test('pressing Stop during the look-ups ends the panel as stopped, not done', async () => {
  const { stopFlag } = await import('../src/stop.js');
  const s = fresh();
  const search = async () => ({ people: [{ name: 'Sam Lee', github: 'samlee', sources: ['npm'] }, { name: 'Tom Ray', github: 'tomray', sources: ['npm'] }] });
  const lookup = async () => { stopFlag.on = true; return { outcome: 'no-match' }; };
  try {
    await searchAndSweep(null, s, cfg, { search: async () => 1, sweep: (p, st, c, o) => runSources(p, st, c, { ...o, search, lookup, pause: false }) });
  } finally { stopFlag.on = false; }
  const w = readSweeps().c1;
  assert.equal(w.state, 'stopped');
  assert.equal(w.funnel.looked, 1);
  assert.equal(w.funnel.waiting, 1);
});

test('people already on file are counted, and only this role\'s person gets this role\'s evidence', async () => {
  const s = fresh();
  s.upsertLead({ url: 'https://www.linkedin.com/in/mine/', name: 'Sam Lee', campaign: 'c1' });
  s.upsertLead({ url: 'https://www.linkedin.com/in/theirs/', name: 'Tom Ray', campaign: 'other' });
  s.data.leads['https://www.linkedin.com/in/mine/'].foundOn = { sources: ['npm'], evidence: [{ label: 'maintains', value: 'a' }] };
  s.save();
  const search = async () => ({ people: [
    { name: 'Sam Lee', github: 'samlee', sources: ['sherlock'], weight: 9, evidence: [{ label: 'rank', value: '3' }] },
    { name: 'Tom Ray', github: 'tomray', sources: ['npm'], weight: 8 },
  ] });
  const lookup = async (page, f) => ({ outcome: 'matched', url: f.name === 'Sam Lee' ? 'https://www.linkedin.com/in/mine/' : 'https://www.linkedin.com/in/theirs/', row: { name: f.name } });
  const sets = [];
  await runSources(null, s, cfg, { search, lookup, pause: false, progress: { step() {}, set: p => sets.push(p) } });
  const mine = s.get('https://www.linkedin.com/in/mine/').foundOn;
  assert.deepEqual(mine.sources, ['npm', 'sherlock'], 'a second site adds to what the first said');
  assert.equal(mine.evidence.length, 2);
  assert.equal(s.get('https://www.linkedin.com/in/theirs/').foundOn, undefined, 'another role\'s person is left alone');
  const f = sets.filter(x => x.funnel).at(-1).funnel;
  assert.deepEqual([f.looked, f.matched, f.already], [2, 0, 2], 'looked up 2, none new, both already in People');
});

test('people matched before foundOn existed still show where they came from', () => {
  assert.deepEqual(legacyFoundOn({ notes: 'found on npm, sherlock (github/samlee)' }), { sources: ['npm', 'sherlock'], evidence: [], github: 'samlee', url: '' });
  assert.deepEqual(legacyFoundOn({ notes: 'found on eips' }).sources, ['eips']);
  assert.equal(legacyFoundOn({ notes: 'met at a conference' }), null);
  const kept = { sources: ['npm'] };
  assert.equal(legacyFoundOn({ foundOn: kept, notes: 'found on eips' }), kept);
});
