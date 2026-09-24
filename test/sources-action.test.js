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

// 24 Sep 2026: the sweep was wired only to the command line, so a Search pressed in the app while
// a run was going never swept and the Finds list stayed empty. Every Search path now ends here.
const { searchAndSweep } = await import('../src/actions/search.js');

test('a Search runs the LinkedIn search first, then sweeps the public sources', async () => {
  const order = [];
  const search = async () => { order.push('linkedin'); return 7; };
  const sweep = async () => { order.push('sources'); };
  const added = await searchAndSweep(null, null, cfg, { search, sweep });
  assert.deepEqual(order, ['linkedin', 'sources'], 'LinkedIn first: the sweep is a bonus on top');
  assert.equal(added, 7, 'the caller still gets the count of new people from LinkedIn');
});

test('a problem in the sweep never loses the LinkedIn results', async () => {
  const search = async () => 4;
  const sweep = async () => { throw new Error('crates.io was down'); };
  assert.equal(await searchAndSweep(null, null, cfg, { search, sweep }), 4,
    'the people found on LinkedIn are saved and the search counts as done');
});

test('being logged out or checkpointed during the sweep still stops everything', async () => {
  for (const name of ['CheckpointError', 'NotLoggedInError']) {
    const boom = new Error('security check'); boom.name = name;
    await assert.rejects(
      () => searchAndSweep(null, null, cfg, { search: async () => 1, sweep: async () => { throw boom; } }),
      e => e.name === name, `${name} must not be swallowed`);
  }
});

test('a one-off URL search looks at that page only and does not sweep', async () => {
  let swept = false;
  await searchAndSweep(null, null, cfg, {
    url: 'https://www.linkedin.com/search/results/people/?keywords=x',
    search: async () => 2, sweep: async () => { swept = true; },
  });
  assert.equal(swept, false);
});

test('a campaign with no role at all sweeps nothing without failing', async () => {
  let swept = false;
  const added = await searchAndSweep(null, null, { name: 'c1' }, { search: async () => 0, sweep: async () => { swept = true; } });
  assert.equal(added, 0);
  assert.equal(swept, false, 'no role means no skills or industry words, so there is nothing to look for');
});

// The bug was in the wiring, so the wiring itself has to be covered: no sweep is injected here, so
// this only passes if searchAndSweep really does reach the runSources in src/actions/sources.js.
// A role with no skills or industry words makes the real runSources return early and touch nothing.
test('with nothing injected, a Search reaches the real public-source sweep', async () => {
  const lines = [];
  const seen = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const added = await searchAndSweep(null, fresh(), { name: 'c1', role: { title: 'Head of Everything' } }, { search: async () => 3 });
    assert.equal(added, 3);
  } finally { console.log = seen; }
  assert.ok(lines.some(l => /only LinkedIn was searched/.test(l)),
    'the real runSources should have run and said it had nothing to look for; got: ' + lines.join(' | '));
});

// The bug was not in a function, it was in the wiring: run.js called the Recruiter search directly
// and so skipped the sweep. Nothing anywhere in src/ may reach past searchAndSweep again.
test('every way of pressing Search goes through searchAndSweep', async () => {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const src = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'src');
  const files = fs.readdirSync(src, { recursive: true })
    .filter(f => f.endsWith('.js'))
    .filter(f => !['actions/search.js', 'actions/recruiter.js'].includes(f.split(path.sep).join('/')));

  let callers = 0;
  for (const f of files) {
    const code = fs.readFileSync(path.join(src, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')                    // block comments
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');                 // line comments, including trailing ones
    // An alias would hide the name, so check what is imported, not only what is called.
    const imported = [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*(?:actions\/search|actions\/recruiter)\.js['"]/g)]
      .flatMap(m => m[1].split(',').map(x => x.trim()));
    for (const name of imported) {
      const local = name.includes(' as ') ? name.split(' as ')[1].trim() : name;
      assert.ok(!/^(runSearch|runRecruiterSearch)$/.test(name.split(' as ')[0].trim()),
        `src/${f} imports ${name}: starting a search there skips the public-source sweep, use searchAndSweep`);
      if (local === 'searchAndSweep') callers++;
    }
  }
  assert.ok(callers >= 2, `expected the app and the command line to start searches through searchAndSweep, found ${callers}`);
});

test('pressing Stop during the LinkedIn half means the sweep never starts', async () => {
  const { stopFlag } = await import('../src/stop.js');
  let swept = false;
  stopFlag.on = true;
  try {
    const added = await searchAndSweep(null, null, cfg, { search: async () => 5, sweep: async () => { swept = true; } });
    assert.equal(added, 5, 'what LinkedIn found is still kept');
  } finally { stopFlag.on = false; }
  assert.equal(swept, false);
});

test('Chrome closing mid-lookup is not written down as a lookup that was tried', async () => {
  const closed = async () => { throw new Error('page.goto: Target page, context or browser has been closed'); };
  await assert.rejects(() => lookupOnLinkedIn(null, { name: 'Sam Lee' }, { collect: closed }), /closed/,
    'the find must stay in the queue for the next Search instead of being marked done');
  const flaky = async () => { throw new Error('Timeout 20000ms exceeded'); };
  assert.equal((await lookupOnLinkedIn(null, { name: 'Sam Lee' }, { collect: flaky })).outcome, 'lookup-failed',
    'an ordinary slow page is still a failed lookup, as before');
});

// 24 Sep 2026: the first live sweep found 153 people and saved none, because searchPublic answers
// { people, problems, manual } and runSources read that as a bare list. Every earlier test injected
// a bare list, so none of them saw it. These use the real shape, and the real function.
test('a sweep saves what the real public search returns, in the shape it really returns it', async () => {
  const s = fresh();
  const search = async () => ({
    people: [{ name: 'Sam Lee', github: 'samlee', sources: ['npm'], weight: 5, evidence: [{ label: 'npm', value: 'maintains iam-kit' }] }],
    problems: [{ source: 'github', error: 'rate limited' }], manual: [],
  });
  const lookup = async () => ({ outcome: 'no-match' });
  const r = await runSources(null, s, cfg, { search, lookup, pause: false });
  assert.equal(r.found, 1);
  assert.ok(s.data.finds['github:samlee'], 'the find must be saved');
});

test('the real searchPublic hands runSources something it can read', async () => {
  const { searchPublic } = await import('../src/sources/search.js');
  const got = await searchPublic({ terms: ['iam'], sources: [], enrich: false });   // no sites, no network
  assert.ok(Array.isArray(got.people), 'searchPublic answers { people: [...] }');
  const s = fresh();
  const r = await runSources(null, s, cfg, { search: () => Promise.resolve(got), lookup: async () => ({ outcome: 'no-match' }), pause: false });
  assert.equal(r.found, 0, 'and runSources reads it without throwing');
});
