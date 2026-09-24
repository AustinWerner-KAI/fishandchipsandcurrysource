// Search 2, which search found whom, and excluded people staying out (24 Sep 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const { Store } = await import('../src/store.js');
const { fileRecruiterRows } = await import('../src/actions/recruiter.js');
const { searchAndSweep } = await import('../src/actions/search.js');
const { runSources } = await import('../src/actions/sources.js');
const { readSweeps } = await import('../src/sweeps.js');

const cfg = { name: 'c1', role: { title: 'Senior IAM security Engineer', location: 'New York', skills: ['IAM'], recruiterSkills: ['AWS'], domain: ['crypto'], boolean: 'IAM AND "Security Engineer" AND crypto' }, dailyCaps: { connects: 10, messages: 10, profileViews: 60 } };
const fresh = () => { const s = new Store(path.join(home, `db-${Math.random()}.json`)); s.save(); return s; };
const row = (id, name, extra = {}) => ({ recruiterUrl: `https://www.linkedin.com/talent/profile/${id}`, name, headline: 'Security Engineer', location: 'New York, New York, United States', company: 'Acme', ...extra });

test('each person is marked with the search that found them, and the overlap is counted', () => {
  const s = fresh();
  const s1 = new Set(), s2 = new Set();
  const a = fileRecruiterRows(s, cfg, [row('A', 'Ann Lee'), row('B', 'Bob Ray')], { tag: 's1', seen: s1 });
  assert.deepEqual(a, { fresh: 2, excluded: 0, overlap: 0 });
  const b = fileRecruiterRows(s, cfg, [row('B', 'Bob Ray'), row('C', 'Cy Wu')], { tag: 's2', seen: s2, other: s1 });
  assert.deepEqual(b, { fresh: 1, excluded: 0, overlap: 1 }, 'Bob was in both: not new again, and counted as overlap');
  const by = id => s.findByRecruiterUrl(`https://www.linkedin.com/talent/profile/${id}`).foundBy;
  assert.deepEqual([by('A'), by('B'), by('C')], [['s1'], ['s1', 's2'], ['s2']]);
});

test('someone Kai excluded never comes back, by any route, and is counted as left out', () => {
  const s = fresh();
  fileRecruiterRows(s, cfg, [row('A', 'Ann Lee')], { tag: 's1' });
  const ann = s.findByRecruiterUrl('https://www.linkedin.com/talent/profile/A');
  s.setStatus(ann.url, 'skipped', { error: 'excluded by hand', skippedByHand: true });
  // same Recruiter profile, found by Search 2
  let r = fileRecruiterRows(s, cfg, [row('A', 'Ann Lee')], { tag: 's2' });
  assert.deepEqual([r.fresh, r.excluded], [0, 1]);
  // the same person under a different Recruiter id (a re-issued link)
  r = fileRecruiterRows(s, cfg, [row('A2', 'Ann Lee')], { tag: 's2' });
  assert.deepEqual([r.fresh, r.excluded], [0, 1]);
  assert.equal(s.findByRecruiterUrl('https://www.linkedin.com/talent/profile/A2'), null, 'no second copy of her');
  assert.equal(s.get(ann.url).status, 'skipped', 'still excluded');
  // she moved job: another company on her profile, and a new Recruiter id
  r = fileRecruiterRows(s, cfg, [row('A3', 'Ann Lee', { company: 'Globex Ltd' })], { tag: 's1' });
  assert.deepEqual([r.fresh, r.excluded], [0, 1], 'an excluded name stays out whatever company it shows');
});

test('someone already contacted is not filed again either; a same-name person at another company is', () => {
  const s = fresh();
  s.upsertLead({ url: 'https://www.linkedin.com/in/sam-lee/', name: 'Sam Lee', company: 'Acme', campaign: 'c1' });
  s.setStatus('https://www.linkedin.com/in/sam-lee/', 'invited');
  const r = fileRecruiterRows(s, cfg, [row('S', 'Sam Lee'), row('S9', 'Sam Lee', { company: 'Globex' })], { tag: 's1' });
  assert.equal(r.fresh, 1, 'the Globex Sam Lee is somebody else');
  assert.equal(s.get('https://www.linkedin.com/in/sam-lee/').status, 'invited');
});

test('another role\'s people are not touched: no marks, no twins', () => {
  const s = fresh();
  s.upsertLead({ url: 'https://www.linkedin.com/in/ann/', name: 'Ann Lee', company: 'Acme', campaign: 'other' });
  const r = fileRecruiterRows(s, cfg, [row('A', 'Ann Lee')], { tag: 's1' });
  assert.equal(r.fresh, 1, 'the same person may be in two roles');
  assert.equal(s.get('https://www.linkedin.com/in/ann/').foundBy, undefined);
});

test('a public-site match of someone Kai excluded stays out, and the find says so', async () => {
  const s = fresh();
  s.upsertLead({ url: 'https://www.linkedin.com/talent/profile/X', name: 'Dee Kay', campaign: 'c1' });
  s.setStatus('https://www.linkedin.com/talent/profile/X', 'skipped', { skippedByHand: true });
  s.save();
  const search = async () => ({ people: [{ name: 'Dee Kay', github: 'deekay', sources: ['npm'], weight: 9 }] });
  const lookup = async () => ({ outcome: 'matched', url: 'https://www.linkedin.com/in/dee-kay/', row: { name: 'Dee Kay' } });
  const sets = [];
  await runSources(null, s, cfg, { search, lookup, pause: false, progress: { step() {}, set: p => sets.push(p) } });
  assert.equal(s.get('https://www.linkedin.com/in/dee-kay/'), undefined, 'not added under her /in/ address');
  assert.equal(s.data.finds['github:deekay'].outcome, 'excluded');
  assert.equal(sets.filter(x => x.funnel).at(-1).funnel.excluded, 1);
});

// ---- the Search button ------------------------------------------------------------------------------
test('every Search runs Search 1, then Search 2 with the skills boolean, then the sweep', async () => {
  const calls = [];
  const search = async (p, st, c, o) => { calls.push('s1'); o.seen.add('u1'); o.report({ page: 1, seen: 10, added: 3 }); return 3; };
  const search2 = async (p, st, c, o) => { calls.push(['s2', o.boolean, o.tag, o.other.has('u1')]); o.report({ page: 1, seen: 8, added: 2, overlap: 1, excluded: 1 }); return 2; };
  const sweep = async () => { calls.push('sweep'); };
  const added = await searchAndSweep(null, null, cfg, { search, search2, sweep });
  assert.equal(added, 5, 'both searches\' new people');
  assert.deepEqual(calls, ['s1', ['s2', '(IAM OR "Identity and Access Management") AND AWS AND security AND crypto NOT (recruiter OR "talent acquisition" OR headhunter)', 's2', true], 'sweep']);
  const w = readSweeps().c1;
  assert.deepEqual([w.steps.recruiter.state, w.steps.recruiter2.state, w.steps.recruiter2.overlap, w.steps.recruiter2.excluded], ['done', 'done', 1, 1]);
  assert.equal(w.state, 'done');
});

test('Search 2 is skipped, and says why, when the role has nothing to build it from', async () => {
  const bare = { name: 'c1', role: { title: 'Head of Sales', boolean: '"Head of Sales"' } };
  let ran = false;
  await searchAndSweep(null, null, bare, { search: async () => 1, search2: async () => { ran = true; }, sources: false });
  assert.equal(ran, false);
  assert.equal(readSweeps().c1.steps.recruiter2.state, 'skipped');
  assert.match(readSweeps().c1.steps.recruiter2.problem, /key skill/);
});

test('a Search 2 problem costs only Search 2; a security check there still stops everything', async () => {
  let swept = false;
  const added = await searchAndSweep(null, null, cfg, { search: async () => 4, search2: async () => { throw new Error('Recruiter hiccup'); }, sweep: async () => { swept = true; } });
  assert.equal(added, 4);
  assert.equal(swept, true, 'the public sites are still searched');
  assert.equal(readSweeps().c1.steps.recruiter2.state, 'failed');
  const boom = new Error('security check'); boom.name = 'CheckpointError';
  await assert.rejects(() => searchAndSweep(null, null, cfg, { search: async () => 1, search2: async () => { throw boom; }, sweep: async () => {} }), e => e.name === 'CheckpointError');
});

test('a LinkedIn-search role (not Recruiter) runs no Search 2', async () => {
  let ran = false;
  await searchAndSweep(null, null, { ...cfg, role: { ...cfg.role, source: 'linkedin' } }, { search: async () => 1, search2: async () => { ran = true; }, sources: false });
  assert.equal(ran, false);
});
