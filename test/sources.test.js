import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './helpers.js';
tmpHome();
const { find, splitAuthored, cleanHandle, isBot } = await import('../src/sources/shape.js');
const { SOURCES, automated, manualOnly, rejected, mayFetch, byId } = await import('../src/sources/registry.js');
const { mergeFinds, keysOf, strong } = await import('../src/sources/merge.js');
const { parseEip } = await import('../src/sources/eips.js');
const { toFinds: seFinds } = await import('../src/sources/stackexchange.js');
const { toFinds: sherlockFinds, linkedTwitter } = await import('../src/sources/sherlock.js');
const { toFinds: npmFinds } = await import('../src/sources/npm.js');
const { toFind: h1Find } = await import('../src/sources/hackerone.js');
const { toFind: ghFind } = await import('../src/sources/github.js');
const { searchPublic } = await import('../src/sources/search.js');

test('a source we are not allowed to fetch cannot be fetched by accident', () => {
  for (const s of manualOnly()) {
    assert.throws(() => mayFetch(s.id), /must not be fetched/, s.id);
  }
  for (const s of rejected()) assert.throws(() => mayFetch(s.id), /must not be fetched/, s.id);
  for (const s of automated()) assert.equal(mayFetch(s.id), true, s.id);
  assert.throws(() => mayFetch('nonesuch'), /Unknown source/);
});

test('every source says what it is licensed for', () => {
  for (const s of SOURCES) {
    assert.ok(s.title, `${s.id} needs a title`);
    if (s.use === 'auto' || s.use === 'manual') assert.ok(s.licence, `${s.id} needs its licence recorded`);
    if (s.use === 'avoid') assert.ok(s.why, `${s.id} needs a reason it was rejected`);
  }
  // the one that would end the business if it were ever switched on
  assert.equal(byId('linkedin-bulk').use, 'avoid');
  assert.match(byId('github').warning, /unsolicited emails|recruiters/);
});

test('an author line becomes a name and a GitHub handle', () => {
  assert.deepEqual(splitAuthored('Vitalik Buterin (@vbuterin)'), { name: 'Vitalik Buterin', github: 'vbuterin', email: '' });
  assert.deepEqual(splitAuthored('lightclient (@lightclient)'), { name: 'lightclient', github: 'lightclient', email: '' });
  assert.equal(splitAuthored('Luis Servin <luis.servin@siemensgamesa.com>').email, 'luis.servin@siemensgamesa.com');
  assert.equal(cleanHandle('@VButerin'), 'vbuterin');
});

test('release robots are not people', () => {
  for (const b of ['GitHub Actions', 'dependabot[bot]', 'renovate', 'semantic-release', 'my-release-bot', 'ci']) {
    assert.equal(isBot({ handle: b, name: b }), true, b);
  }
  assert.equal(isBot({ handle: 'npm-oidc', email: 'npm-oidc-no-reply@github.com' }), true);
  for (const p of ['Richard Moore', 'awkweb', 'vbuterin', 'Tjaden Hess']) {
    assert.equal(isBot({ handle: p, name: p }), false, p);
  }
});

test('EIP front matter gives every author', () => {
  const doc = parseEip(`---
eip: 4844
title: Shard Blob Transactions
author: Vitalik Buterin (@vbuterin), Dankrad Feist (@dankrad), Matt Garnett (@lightclient)
status: Final
type: Standards Track
category: Core
created: 2022-02-25
---
body`);
  assert.equal(doc.number, '4844');
  assert.equal(doc.category, 'Core');
  assert.equal(doc.authors.length, 3);
  assert.equal(splitAuthored(doc.authors[1]).github, 'dankrad');
  assert.equal(parseEip('no front matter here'), null);
});

test('Stack Exchange ranks within its own results and only flags someone properly gone', () => {
  const now = Date.parse('2026-09-24T00:00:00Z');
  const at = days => Math.floor((now - days * 86400000) / 1000);
  const finds = seFinds([
    { score: 2764, post_count: 1008, user: { display_name: 'Top', reputation: 55631, last_access_date: at(29), location: 'Calgary' } },
    { score: 1558, post_count: 113, user: { display_name: 'Away', reputation: 37442, last_access_date: at(175) } },
    { score: 120, post_count: 30, user: { display_name: 'Small', reputation: 900, last_access_date: at(3) } },
  ], 'ethereum.stackexchange.com', 'solidity', now);
  assert.equal(finds[0].weight, 90);
  assert.ok(finds[2].weight < finds[1].weight && finds[1].weight < finds[0].weight, 'scores must spread out');
  assert.equal(finds[0].location, 'Calgary');
  const quiet = f => f.evidence.some(e => e.label === 'gone quiet');
  assert.equal(quiet(finds[0]), false, 'a month away is normal');
  assert.equal(quiet(finds[1]), true, 'six months away is worth knowing');
  assert.equal(quiet(finds[2]), false);
});

test('Sherlock: teams are dropped, and a linked Twitter is not a handle', () => {
  // checked against the live board: twitter_images filenames are UUIDs, not handles
  const url = 'https://sherlock-files.ams3.digitaloceanspaces.com/twitter_images/20525035-db99-44bc-b5ff-9f6dc755a078.jpg';
  assert.equal(linkedTwitter(url), true);
  assert.equal(linkedTwitter('https://.../profile_images/defaults/default_avatar_0.png'), false);
  const finds = sherlockFinds({
    '0x52': { payout: 1174959, ranking: 2, senior: true, senior_tier: 1, days: 454, is_team: false, profile_picture_url: url },
    'a-team': { payout: 900000, ranking: 3, senior: true, is_team: true },
    'minor': { payout: 500, ranking: 900, senior: false, is_team: false },
  }, { seniorOnly: true });
  assert.deepEqual(finds.map(f => f.handle), ['0x52'], 'teams and non-seniors are left out');
  assert.equal(finds[0].twitter, '', 'we must not invent a Twitter handle from a UUID');
  assert.ok(finds[0].evidence.some(e => /linked Twitter/.test(e.label)));
  assert.match(finds[0].url, /audits\.sherlock\.xyz/);
});

test('npm groups packages under one maintainer and leaves the robots out', () => {
  const finds = npmFinds([
    { package: { name: 'viem', date: '2026-06-18T00:00:00Z', publisher: { username: 'awkweb', email: 'tom@meagher.co' }, maintainers: [{ name: 'GitHub Actions', email: 'npm-oidc-no-reply@github.com' }] } },
    { package: { name: 'ox', date: '2026-07-01T00:00:00Z', publisher: { username: 'awkweb', email: 'tom@meagher.co' }, maintainers: [] } },
  ]);
  assert.equal(finds.length, 1);
  assert.equal(finds[0].email, 'tom@meagher.co');
  assert.equal(finds[0].lastActiveAt, '2026-07-01T00:00:00Z');
  assert.deepEqual(finds[0].evidence.map(e => e.value), ['viem', 'ox']);
});

test('GitHub gives no email and no organisations, whatever the API returns', () => {
  const f = ghFind({ login: 'someone', name: 'A Person', email: 'private@example.com', company: '@stripe', location: 'London', public_repos: 12, hireable: true, html_url: 'https://github.com/someone' });
  assert.equal(f.email, '', 'GitHub email must never be collected: their policy forbids what we would do with it');
  assert.equal(f.company, 'stripe');
  assert.ok(f.evidence.some(e => e.label === 'open to work'));
  assert.equal(ghFind({ login: 'ethereum', type: 'Organization' }), null);
});

test('people found on different sites become one person, and strangers do not', () => {
  const finds = [
    find('eips', { handle: 'vbuterin', name: 'Vitalik Buterin', github: 'vbuterin', weight: 95 }),
    find('github', { handle: 'vbuterin', name: 'Vitalik Buterin', github: 'vbuterin', location: 'Earth', weight: 65 }),
    find('hackerone', { handle: 'h1user', name: 'James Kettle', github: 'albinowax', twitter: 'albinowax', weight: 90 }),
    find('sherlock', { handle: 'albinowax', twitter: 'albinowax', weight: 95 }),
    find('stackexchange', { handle: 'John Hammond', name: 'John Hammond', location: 'London', weight: 60 }),
    find('npm', { handle: 'jh2', name: 'John Hammond', location: 'Sydney', email: 'x@y.com', weight: 55 }),
  ];
  const people = mergeFinds(finds);
  const vit = people.find(p => p.name === 'Vitalik Buterin');
  assert.deepEqual(vit.sources.sort(), ['eips', 'github']);
  assert.equal(vit.location, 'Earth');
  const kettle = people.find(p => p.name === 'James Kettle');
  assert.deepEqual(kettle.sources.sort(), ['hackerone', 'sherlock'], 'a Twitter handle joins the pseudonym to the person');
  assert.equal(people.filter(p => p.name === 'John Hammond').length, 2, 'two people with one name stay apart');
  assert.deepEqual(keysOf(find('x', { github: 'A', email: 'B@c.com', twitter: 'D' })), ['gh:a', 'em:b@c.com', 'tw:d']);
  assert.ok(strong(people).length >= 2);
});

test('one site failing does not stop the rest, and it is reported', async () => {
  const ops = {
    searchEips: async () => [find('eips', { handle: 'vbuterin', name: 'Vitalik Buterin', github: 'vbuterin', weight: 95 })],
    searchStackExchange: async () => { const e = new Error('throttled, 55 minutes left'); e.rateLimited = true; throw e; },
    searchSherlock: async () => [find('sherlock', { handle: '0x52', weight: 95 })],
    searchNpm: async () => [],
    searchCrates: async () => [],
    searchGitHub: async () => { throw new Error('rate limited or refused (403)'); },
    lookupHackerOne: async ({ handle }) => (handle === '0x52'
      ? find('hackerone', { handle: '0x52', name: 'A Real Person', github: 'realperson', weight: 90 }) : null),
    lookupCrates: async () => null,
    lookupGitHub: async () => null,
  };
  const r = await searchPublic({ terms: ['solidity'], ops });
  assert.equal(r.problems.length, 2);
  assert.ok(r.problems.find(p => p.source === 'stackexchange').rateLimited);
  assert.ok(r.people.some(p => p.name === 'Vitalik Buterin'));
  // the lookup agreed on nothing but the handle, so it is offered as a suggestion, not merged
  assert.ok(r.people.some(p => (p.handles.sherlock || []).includes('0x52')));
  assert.ok(r.people.some(p => p.evidence.some(e => /possibly the same person/.test(e.label))));
  assert.deepEqual(r.manual.map(m => m.id).sort(), ['cisa-ics', 'code4rena', 'defcon', 'immunefi']);
  await assert.rejects(() => searchPublic({ terms: [], ops }), /at least one subject/);
});

test('HackerOne turns a handle into someone we can find again', () => {
  const f = h1Find({ username: 'albinowax', name: 'James Kettle', reputation: 3426, signal: 6.6, impact: 28.4, github_handle: 'albinowax', twitter_handle: 'albinowax', created_at: '2016-02-15T11:34:15Z' });
  assert.equal(f.name, 'James Kettle');
  assert.equal(f.github, 'albinowax');
  assert.ok(f.weight > 80);
  assert.equal(h1Find({}), null);
});

test('a resolved name joins back to the pseudonym it came from', () => {
  // this is the bug the first version had: the answer could not be matched to the question
  const people = mergeFinds([
    find('sherlock', { handle: '0x52', weight: 95, evidence: [{ label: 'paid', value: '$1.1m' }] }),
    find('hackerone', { handle: 'zerofiftytwo', name: 'A Real Person', github: 'realperson', weight: 90, aliases: [{ source: 'sherlock', handle: '0x52' }] }),
  ]);
  assert.equal(people.length, 1);
  assert.equal(people[0].name, 'A Real Person');
  assert.deepEqual(people[0].handles.sherlock, ['0x52']);
  assert.deepEqual(people[0].sources.sort(), ['hackerone', 'sherlock']);
});

test('the same handle on two different sites is not the same person', () => {
  const people = mergeFinds([
    find('sherlock', { handle: '0x52', weight: 90 }),
    find('github', { handle: '0x52', github: 'someone-else', weight: 60 }),
  ]);
  assert.equal(people.length, 2, 'a bare handle only counts alongside the site it came from');
});

// ---- what the audit on 24 Sep found. Every one of these let a real person be lost, or an
// address reach a place it should never have reached.

const { personalEmail, scrubEmails, nameKey, isFullName } = await import('../src/sources/shape.js');
const { splitAuthors } = await import('../src/sources/eips.js');
const { corroborates } = await import('../src/sources/search.js');
const { HOSTS } = await import('../src/sources/registry.js');

test('no GitHub address reaches anything we show, whichever field it hides in', () => {
  const f = ghFind({ login: 'u', name: 'A Person me@work.dev', bio: 'Hire me: me@personal.dev', company: 'Acme (jobs@acme.io)', location: 'London me@x.io', email: 'private@example.com' });
  assert.equal(f.email, '');
  const everything = JSON.stringify(f);
  assert.ok(!/me@personal\.dev|private@example\.com|jobs@acme\.io|me@work\.dev|me@x\.io/.test(everything), everything);
  assert.match(f.evidence.find(e => e.label === 'bio').value, /\[email removed\]/);
});

test('Stack Exchange takes no address at all, and reads an employer without swallowing the prose', () => {
  const [f] = seFinds([{ score: 10, post_count: 1, user: { display_name: 'a', about_me: 'I work at Acme. For vulnerability reports mail security@acme.com, not me.' } }], 's', 't');
  assert.equal(f.email, '', 'an address in prose is as likely to be somebody else’s');
  assert.equal(f.company, 'Acme');
});

test('a shared inbox is never treated as one person’s address', () => {
  for (const role of ['security@acme.com', 'oss@acme.io', 'info@x.com', 'jobs@y.com', 'noreply@z.com', '123+me@users.noreply.github.com']) {
    assert.equal(personalEmail(role), '', role);
  }
  assert.equal(personalEmail('me@ricmoo.com'), 'me@ricmoo.com');
  assert.equal(personalEmail('not an email'), '');
  assert.equal(scrubEmails('reach me at a@b.com now'), 'reach me at [email removed] now');
});

test('two people on one team inbox stay two people', () => {
  const people = mergeFinds([
    find('npm', { handle: 'dev-one', name: 'Dana One', email: 'oss@acme.io', weight: 55 }),
    find('npm', { handle: 'dev-two', name: 'Eli Two', email: 'oss@acme.io', weight: 55 }),
  ]);
  assert.equal(people.length, 2);
});

test('a find touching two people joins neither of them together', () => {
  const people = mergeFinds([
    find('github', { handle: 'alice', name: 'Alice Adams', github: 'alice', weight: 60 }),
    find('stackexchange', { handle: 'Bob Brown', name: 'Bob Brown', twitter: 'bobby', weight: 60 }),
    find('hackerone', { handle: 'x', name: 'Someone Else', github: 'alice', twitter: 'bobby', weight: 90 }),
    find('npm', { handle: 'bb', name: 'Bob Brown', twitter: 'bobby', email: 'bob@b.com', weight: 55 }),
  ]);
  const alice = people.find(p => p.name === 'Alice Adams');
  const bob = people.find(p => p.name === 'Bob Brown');
  assert.ok(alice && bob, 'both must survive');
  assert.equal(alice.email, '', 'one person’s address must never land on another');
  assert.equal(bob.email, 'bob@b.com');
});

test('a name and a city is not enough to call two people one person', () => {
  assert.equal(mergeFinds([
    find('stackexchange', { handle: 'John Smith', name: 'John Smith', location: 'London', weight: 60 }),
    find('npm', { handle: 'jsmith', name: 'John Smith', location: 'London', weight: 55 }),
  ]).length, 2);
  // the same name at the same employer is
  assert.equal(mergeFinds([
    find('stackexchange', { handle: 'a', name: 'John Smith', company: 'Acme', weight: 60 }),
    find('npm', { handle: 'b', name: 'John Smith', company: 'Acme', weight: 55 }),
  ]).length, 1);
});

test('names outside the Latin alphabet join like any other', () => {
  assert.equal(nameKey('Péter Garamvölgyi'), nameKey('Peter Garamvolgyi'));
  assert.ok(isFullName('Владимир Иванов'));
  assert.equal(mergeFinds([
    find('stackexchange', { handle: 'a', name: 'Владимир Иванов', company: 'Acme', weight: 60 }),
    find('npm', { handle: 'b', name: 'Владимир Иванов', company: 'Acme', weight: 55 }),
  ]).length, 1);
});

test('two accounts on one site are both kept, not overwritten', () => {
  const [p] = mergeFinds([
    find('npm', { handle: 'sindre', name: 'S R', github: 'g', url: 'https://www.npmjs.com/~sindre', weight: 55 }),
    find('npm', { handle: 'sindre-work', name: 'S R', github: 'g', url: 'https://www.npmjs.com/~sindre-work', weight: 55 }),
  ]);
  assert.deepEqual(p.handles.npm, ['sindre', 'sindre-work']);
  assert.equal(p.urls.npm.length, 2);
});

test('a dozen entries from one site do not make someone a 100', () => {
  const many = Array.from({ length: 12 }, (_, i) => find('eips', { handle: 'v', name: 'V B', github: 'v', weight: 80, evidence: [{ label: `e${i}`, value: 'x' }] }));
  assert.equal(mergeFinds(many)[0].score, 80);
});

test('a lookup only joins a pseudonym when something beyond the handle agrees', () => {
  const person = { twitter: 'jackx', github: '', email: '', evidence: [], sources: ['sherlock'], handles: { sherlock: ['jack'] } };
  assert.equal(corroborates(person, { twitter: 'jackx', name: 'Jack Real' }), true);
  assert.equal(corroborates(person, { twitter: '', github: 'someone', name: 'Jack Unrelated' }), false);
  assert.equal(corroborates(null, null), false);
});

test('an unconfirmed match is shown as a suggestion, never welded on', async () => {
  const none = async () => [];
  const ops = {
    searchEips: none, searchStackExchange: none, searchNpm: none, searchCrates: none, searchGitHub: none,
    searchSherlock: async () => [find('sherlock', { handle: 'jack', weight: 95 })],
    lookupHackerOne: async () => find('hackerone', { handle: 'jack', name: 'Jack Unrelated', github: 'jack-unrelated', weight: 70 }),
    lookupCrates: async () => null, lookupGitHub: async () => null,
  };
  const r = await searchPublic({ terms: ['x'], ops });
  assert.equal(r.people.length, 2, 'the same handle on two sites is not the same person');
  assert.ok(r.people.some(p => p.evidence.some(e => /possibly the same person/.test(e.label))));
});

test('EIP author lines survive commas, YAML lists and a byte order mark', () => {
  assert.deepEqual(splitAuthors('Smith, Jr. (@sj), Other One (@oo)'), ['Smith, Jr. (@sj)', 'Other One (@oo)']);
  assert.deepEqual(splitAuthors('Vitalik Buterin (@vbuterin), lightclient (@lightclient)'), ['Vitalik Buterin (@vbuterin)', 'lightclient (@lightclient)']);
  const yaml = parseEip('---\nerc: 20\ntitle: Token\nauthor:\n  - A One (@a)\n  - B Two (@b)\ncreated: 2015-11-19\n---\nbody', 'ERC');
  assert.equal(yaml.authors.length, 2, 'a YAML list of authors must not vanish');
  assert.equal(parseEip('﻿---\neip: 7\ntitle: T\nauthor: A One (@a)\ncreated: 2015-01-01\n---\nx').number, '7');
  assert.equal(parseEip('---\r\neip: 9\r\ntitle: T\r\nauthor: A One (@a)\r\n---\r\nx').number, '9');
});

test('EIP authors bring no email, because those addresses are GitHub’s', () => {
  const doc = parseEip('---\neip: 1\ntitle: T\nauthor: Someone (@someone) <12345+someone@users.noreply.github.com>\ncreated: 2015-01-01\n---\nx');
  assert.equal(doc.authors.length, 1);
  // the name must not carry the handle or the address along with it
  const who = splitAuthored(doc.authors[0]);
  assert.equal(who.name, 'Someone');
  assert.equal(who.github, 'someone');
  assert.equal(personalEmail(who.email), '', 'a GitHub-issued address is not an address we keep');
});

test('nothing we are not allowed to fetch can be switched on at runtime', () => {
  assert.ok(Object.isFrozen(SOURCES));
  for (const s of SOURCES) assert.ok(Object.isFrozen(s), s.id);
  assert.throws(() => mayFetch('code4rena'), /must not be fetched/);
  // every automated source is pinned to the hosts it is allowed to end up on
  for (const s of automated()) {
    if (s.id === 'eips' || s.id === 'trailofbits') continue;   // these are git clones, not fetches
    assert.ok(HOSTS[s.id]?.length, `${s.id} needs its hosts pinned so a redirect cannot move it`);
  }
});

test('a bad API shape takes out nothing', () => {
  for (const bad of [null, undefined, {}, 'a string', 42]) {
    assert.doesNotThrow(() => npmFinds(bad), `npm ${bad}`);
    assert.doesNotThrow(() => seFinds(bad, 's', 't'), `stackexchange ${bad}`);
    assert.doesNotThrow(() => sherlockFinds(bad), `sherlock ${bad}`);
    assert.doesNotThrow(() => mergeFinds(bad), `merge ${bad}`);
  }
  assert.deepEqual(npmFinds([null, { package: { maintainers: {} } }]), []);
  assert.equal(ghFind({ login: 123 }), null);
  assert.equal(h1Find({ username: 'u', signal: '6.6', impact: '2' }).evidence.find(e => e.label === 'report quality').value, '6.60');
  assert.equal(isBot(null), false);
});
