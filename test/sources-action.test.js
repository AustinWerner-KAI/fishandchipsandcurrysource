import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const { Store } = await import('../src/store.js');
const { runSources, termsForRole, findKey, sameHuman, lookupOnLinkedIn } = await import('../src/actions/sources.js');

const cfg = {
  name: 'c1', role: { title: 'Senior Cloud Security Engineer', location: 'Dubai', skills: ['cloud security'], domain: ['crypto'] },
  dailyCaps: { connects: 10, messages: 10, profileViews: 60 },
};
const fresh = () => { const s = new Store(path.join(home, `db-${Math.random()}.json`)); s.save(); return s; };

test('the search terms come from the work, not the job title', () => {
  assert.deepEqual(termsForRole(cfg), ['cloud security', 'crypto']);
  assert.deepEqual(termsForRole({ role: { title: 'Head of Everything' } }), [],
    'nobody writes a job title in a commit, so a role with no skills searches nothing');
});

test('one key per human, the GitHub handle when there is one', () => {
  assert.equal(findKey({ github: 'VButerin', sources: ['eips'] }), 'github:vbuterin');
  assert.equal(findKey({ handle: 'zachobront', sources: ['sherlock'] }), 'sherlock:zachobront');
  assert.equal(findKey({}), '');
});

test('a name has to match properly before anybody is contacted', () => {
  assert.equal(sameHuman('Sam Lee', 'Sam Lee'), true);
  assert.equal(sameHuman('Sam Lee', 'Sam David Lee'), true, 'a middle name is still them');
  assert.equal(sameHuman('Sam Lee', 'Samantha Leeming'), false, 'a prefix is somebody else');
  assert.equal(sameHuman('Sam Lee', 'Lee Sam'), false, 'the other way round is somebody else');
  assert.equal(sameHuman('Sam', 'Sam Lee'), false, 'one word is never enough');
  assert.equal(sameHuman('José Álvarez', 'Jose Alvarez'), true, 'accents are the same person');
});

test('two people of the same name stop the lookup rather than guessing', async () => {
  const collect = async () => [
    { slug: 'sam-lee-1', name: 'Sam Lee', headline: 'Engineer', location: 'Dubai', degree: '2nd' },
    { slug: 'sam-lee-2', name: 'Sam Lee', headline: 'Other Engineer', location: 'London', degree: '3rd' },
  ];
  assert.equal((await lookupOnLinkedIn({}, { name: 'Sam Lee' }, { collect })).outcome, 'ambiguous');
  const one = async () => [{ slug: 'sam-lee-1', name: 'Sam Lee', headline: 'Engineer', location: 'Dubai', degree: '2nd' }];
  const hit = await lookupOnLinkedIn({}, { name: 'Sam Lee' }, { collect: one });
  assert.equal(hit.outcome, 'matched');
  assert.equal(hit.url, 'https://www.linkedin.com/in/sam-lee-1/');
  const none = async () => [{ slug: 'x', name: 'Someone Else', headline: '', location: '', degree: '' }];
  assert.equal((await lookupOnLinkedIn({}, { name: 'Sam Lee' }, { collect: none })).outcome, 'no-match');
  assert.equal((await lookupOnLinkedIn({}, { name: 'Prince' }, { collect: one })).outcome, 'no-name');
});

test('a public find is filed, placed on LinkedIn, and never written down with an address', async () => {
  const s = fresh();
  const search = async () => ([
    { name: 'Ada Lovelace', github: 'adal', company: 'CertiK', sources: ['github', 'eips'], weight: 95,
      lastActiveAt: '2026-09-01', evidence: [{ label: 'EIP-7702', value: 'write to ada@example.com about it' }] },
    { name: 'Nobody Here', github: 'nob', sources: ['npm'], weight: 10, evidence: [] },
  ]);
  const lookup = async (_p, f) => f.name === 'Ada Lovelace'
    ? { outcome: 'matched', url: 'https://www.linkedin.com/in/ada/', row: { name: 'Ada Lovelace', headline: 'Security Engineer', location: 'Dubai', degree: '2nd' } }
    : { outcome: 'no-match' };

  const r = await runSources(null, s, cfg, { search, lookup, pause: false });
  assert.equal(r.found, 2);
  assert.equal(r.matched, 1);

  const lead = s.get('https://www.linkedin.com/in/ada/');
  assert.ok(lead, 'the one placed on LinkedIn joins the normal list');
  assert.equal(lead.campaign, 'c1');
  assert.match(lead.notes, /found on github, eips \(github\/adal\)/);
  assert.equal(lead.status, 'new');
  assert.equal(lead.approved, false, 'nothing is approved without you');

  const filed = s.data.finds['github:adal'];
  assert.equal(filed.outcome, 'matched');
  assert.equal(filed.matchedUrl, 'https://www.linkedin.com/in/ada/');
  assert.equal(s.data.finds['github:nob'].outcome, 'no-match');

  // GitHub's policy forbids using what is there to email people, so no address is ever stored
  const asJson = JSON.stringify(s.data);
  assert.ok(!asJson.includes('ada@example.com'), 'an address must never survive into the database');
  assert.match(filed.evidence[0].value, /\[email removed\]/);
});

test('a second search adds evidence rather than a second row, and does not look anybody up twice', async () => {
  const s = fresh();
  const first = async () => ([{ name: 'Ada Lovelace', github: 'adal', sources: ['github'], weight: 80, evidence: [{ label: 'repo', value: 'one' }] }]);
  const second = async () => ([{ name: 'Ada Lovelace', github: 'AdaL', sources: ['eips'], weight: 95, evidence: [{ label: 'EIP-7702', value: 'author' }] }]);
  let lookups = 0;
  const lookup = async () => { lookups++; return { outcome: 'no-match' }; };

  await runSources(null, s, cfg, { search: first, lookup, pause: false });
  await runSources(null, s, cfg, { search: second, lookup, pause: false });

  assert.equal(Object.keys(s.data.finds).length, 1, 'one human, one row');
  const f = s.data.finds['github:adal'];
  assert.deepEqual(f.sources.sort(), ['eips', 'github']);
  assert.equal(f.evidence.length, 2, 'the second pass added what it knew');
  assert.equal(f.weight, 95, 'and the strongest weight wins');
  assert.equal(lookups, 1, 'somebody already looked up is never looked up again');
});

test('the lookups stop at the profile view cap rather than burning the day on them', async () => {
  const s = fresh();
  const many = async () => Array.from({ length: 30 }, (_, i) => ({ name: `Person Number${i}`, github: `gh${i}`, sources: ['github'], weight: 50 - i }));
  let lookups = 0;
  const lookup = async () => { lookups++; return { outcome: 'no-match' }; };
  const r = await runSources(null, s, { ...cfg, dailyCaps: { ...cfg.dailyCaps, profileViews: 3 } }, { search: many, lookup, pause: false });
  assert.equal(r.found, 30, 'everyone found is filed');
  assert.ok(lookups <= 4, `only a few are looked up, got ${lookups}`);
  assert.equal(s.findRows('c1').filter(f => !f.lookedUpAt).length, 30 - lookups, 'the rest wait for the next search');
});

test('only the sources the licences allow are ever fetched', async () => {
  const { automated, manualOnly, rejected } = await import('../src/sources/registry.js');
  const auto = automated().map(s => s.id);
  for (const s of [...manualOnly(), ...rejected()]) assert.ok(!auto.includes(s.id), `${s.id} must not run by itself`);
  assert.ok(auto.includes('github'));
  assert.ok(!auto.includes('linkedin-bulk'), 'bulk scraping LinkedIn is what got hiQ ordered to destroy their data');
});
