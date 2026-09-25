// The role reader, the job link reader, the role check and learning (24 Sep 2026).
// Built from a real miss: Kai pasted the Palantir "Software Engineer - Environment Platform" spec
// without its title, and Sourcer made a role titled "New York, NY" that searched for
// `New AND ("York, NY" OR "Senior York, NY" ...)`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
tmpHome();
const { draftRole, titleCandidates, splitTeam, isPlace, secondSearchFor, genericTitle } = await import('../src/role.js');
const { jobLinkSource, readJobLink, htmlToText, isJobLink } = await import('../src/joblink.js');
const { checkRole, strayTerms } = await import('../src/rolecheck.js');
const { recordLesson, vocab, score, summary } = await import('../src/rolelearn.js');

const PALANTIR = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/spec-palantir.txt'), 'utf8');   // the spec, without its title line
const EXCL = 'NOT (recruiter OR "talent acquisition" OR headhunter)';

// ---- reading the title ---------------------------------------------------------------------------
test('the Palantir spec without its title is read as a Software Engineer role, never "New York, NY"', () => {
  const d = draftRole(PALANTIR);
  assert.equal(d.title, 'Software Engineer');
  assert.equal(d.family, 'engineering');
  assert.deepEqual(d.titleOptions, ['Software Engineer', 'Platform Engineer', 'Infrastructure Engineer']);
  assert.equal(d.location, 'New York');
  assert.equal(d.workType, 'hybrid');
  assert.deepEqual(d.recruiterSkills, ['Kubernetes']);
  assert.ok(!d.skills.includes('ecosystem'), 'a commercial word is never an engineer\'s skill');
  assert.equal(d.boolean, `("Software Engineer" OR "Senior Software Engineer" OR "Platform Engineer" OR "Infrastructure Engineer" OR "Backend Engineer") AND (Kubernetes OR K8s) ${EXCL}`);
  assert.equal(d.boolean2, `(Kubernetes OR K8s) AND (Go OR Golang OR Java) AND ("distributed systems" OR microservices OR apis OR controllers) AND (engineer OR developer) ${EXCL}`);
});

test('"Role - Team" titles: the team is split off and kept as a hint', () => {
  const d = draftRole('Software Engineer - Environment Platform\n' + PALANTIR);
  assert.equal(d.title, 'Software Engineer');
  assert.equal(d.team, 'Environment Platform');
  assert.deepEqual(splitTeam('Senior Backend Engineer | Payments'), { title: 'Senior Backend Engineer', team: 'Payments' });
  assert.deepEqual(splitTeam('Head of Sales, EMEA'), { title: 'Head of Sales', team: 'EMEA' });
  assert.deepEqual(splitTeam('Engineering Manager - Staff Engineer'), { title: 'Engineering Manager - Staff Engineer', team: '' }, 'two titles: kept whole, not guessed');
});

test('a job link\'s title wins over any guess', () => {
  const d = draftRole(PALANTIR, { title: 'Software Engineer - Environment Platform', location: 'New York, NY', workType: 'hybrid', company: 'Palantir' });
  assert.deepEqual([d.title, d.team, d.location, d.workType, d.company], ['Software Engineer', 'Environment Platform', 'New York, NY', 'hybrid', 'Palantir']);
});

test('places, pay, work type and links are never titles', () => {
  for (const line of ['New York, NY', 'Dubai, UAE', 'Full-time / Hybrid', '$135,000 - $200,000 a year', 'https://jobs.lever.co/x/y', 'Remote'])
    assert.deepEqual(titleCandidates(`${line}\nWe want great people.`), [], line);
  assert.equal(isPlace('Go'), false, 'a two-letter word on its own is not a place');
  assert.equal(isPlace('York, NY'), true);
});

test('titled roles keep exactly the search Kai\'s pattern gives them', () => {
  assert.equal(draftRole('Senior Rust Engineer\nFully remote. Distributed systems.').boolean, `("Rust Engineer" OR "Senior Rust Engineer" OR "Lead Rust Engineer" OR "Principal Rust Engineer") ${EXCL}`);
  assert.equal(draftRole('Senior Cloud Security Engineer\nLocation: New York (hybrid)\nWe are a crypto exchange.').boolean,
    `Cloud AND ("Security Engineer" OR "Senior Security Engineer" OR "Lead Security Engineer" OR "Principal Security Engineer") ${EXCL}`);
  assert.equal(genericTitle('Software Engineer'), true);
  assert.equal(genericTitle('Senior Backend Developer'), true);
  assert.equal(genericTitle('Rust Engineer'), false);
  assert.equal(genericTitle('Cloud Security Engineer'), false);
});

test('Search 2 for Kai\'s live roles: skills first, titles never, industry as in Search 1', () => {
  const iam = { title: 'Senior IAM security Engineer', skills: ['IAM'], recruiterSkills: ['AWS'], domain: ['crypto', 'web3'], exclude: ['recruiter'] };
  assert.equal(secondSearchFor(iam), '(IAM OR "Identity and Access Management") AND AWS AND security AND (crypto OR web3) NOT recruiter', 'the title\'s own skill first, then the key skill');
  assert.equal(secondSearchFor({ ...iam, boolean2: 'mine' }), 'mine', 'a Search 2 Kai wrote is kept');
  assert.equal(secondSearchFor({ title: 'Head of Sales', skills: [], recruiterSkills: [] }), '', 'nothing to build it from: no Search 2, rather than a one-word search');
});

// ---- job links ------------------------------------------------------------------------------------
test('job links from Lever, Greenhouse and Ashby are recognised; anything else is not', () => {
  assert.deepEqual(jobLinkSource('https://jobs.lever.co/palantir/d5d83a8f-cb96-41cc-9612-c7224fbb2fbc'), { board: 'lever', company: 'palantir', id: 'd5d83a8f-cb96-41cc-9612-c7224fbb2fbc', api: 'https://api.lever.co/v0/postings/palantir/d5d83a8f-cb96-41cc-9612-c7224fbb2fbc' });
  assert.equal(jobLinkSource('https://job-boards.greenhouse.io/kraken/jobs/7123456').api, 'https://boards-api.greenhouse.io/v1/boards/kraken/jobs/7123456');
  assert.equal(jobLinkSource('https://jobs.ashbyhq.com/acme/0b1c-2d3e').board, 'ashby');
  assert.equal(jobLinkSource('https://www.linkedin.com/jobs/view/123'), null);
  assert.equal(jobLinkSource('javascript:alert(1)'), null);
  assert.equal(isJobLink('https://jobs.lever.co/x/y'), true);
  assert.equal(isJobLink('Software Engineer\nhttps://jobs.lever.co/x/y'), false, 'a spec that mentions a link is still a spec');
});

const fakeFetch = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
test('a Lever link gives the exact title, location, work type and the full text', async () => {
  const lever = { text: 'Software Engineer - Environment Platform', workplaceType: 'hybrid', categories: { location: 'New York, NY', commitment: 'Full-time' },
    descriptionPlain: 'Palantir builds software.', lists: [{ text: 'What We Require', content: '<li>3+ years of professional software development</li><li>Go or Java</li>' }], additionalPlain: '$135,000 - $200,000/year' };
  const j = await readJobLink('https://jobs.lever.co/palantir/abc', { fetchImpl: fakeFetch(200, lever) });
  assert.deepEqual([j.board, j.title, j.location, j.workType, j.company], ['lever', 'Software Engineer - Environment Platform', 'New York, NY', 'hybrid', 'Palantir']);
  assert.match(j.text, /What We Require\n- 3\+ years of professional software development\n- Go or Java/);
  const d = draftRole(j.text, j);
  assert.equal(d.title, 'Software Engineer');
});

test('Greenhouse and Ashby links are read too', async () => {
  const gh = await readJobLink('https://boards.greenhouse.io/kraken/jobs/42', { fetchImpl: fakeFetch(200, { title: 'Senior Security Engineer', location: { name: 'Remote - US' }, content: '&lt;p&gt;Protect &amp;amp; defend.&lt;/p&gt;', company_name: 'Kraken' }) });
  assert.deepEqual([gh.title, gh.location, gh.workType, gh.company], ['Senior Security Engineer', 'Remote - US', 'remote', 'Kraken']);
  assert.match(gh.text, /Protect & defend\./);
  const ash = await readJobLink('https://jobs.ashbyhq.com/acme/id-2', { fetchImpl: fakeFetch(200, { jobs: [{ id: 'id-1', title: 'x' }, { id: 'id-2', title: 'Platform Engineer', location: 'London', isRemote: false, workplaceType: 'Hybrid', descriptionPlain: 'K8s' }] }) });
  assert.deepEqual([ash.title, ash.location, ash.workType], ['Platform Engineer', 'London', 'hybrid']);
});

test('a dead or unreadable link says so plainly, and never becomes a title', async () => {
  await assert.rejects(() => readJobLink('https://jobs.lever.co/palantir/gone', { fetchImpl: fakeFetch(404, {}) }), /does not exist any more\. Paste the job text/);
  await assert.rejects(() => readJobLink('https://careers.example.com/job/1'), /Lever, Greenhouse and Ashby/);
  await assert.rejects(() => readJobLink('https://jobs.lever.co/a/b', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } }), /Could not reach Lever/);
  assert.equal(htmlToText('<p>One</p><ul><li>Two</li></ul>'), 'One\n- Two');
});

// ---- the role check ------------------------------------------------------------------------------
test('the role check stops the Palantir mistake, with the reason and a fix', () => {
  const broken = { title: 'New York, NY', location: 'New York', workType: 'hybrid', titles: ['York, NY', 'Senior York, NY'], boolean: 'New AND ("York, NY" OR "Senior York, NY") NOT (recruiter)', recruiterSkills: ['Kubernetes'] };
  const c = checkRole(broken, { text: PALANTIR });
  const byId = id => c.find(x => x.id === id);
  assert.equal(byId('title').level, 'bad');
  assert.match(byId('title').title, /looks like a place/);
  assert.equal(byId('title').fix.kind, 'pickTitle');
  assert.equal(byId('stray').level, 'bad');
  assert.match(byId('stray').detail, /"New" is a stray word/);
  assert.equal(byId('titles').level, 'bad');
});

test('the new Palantir draft passes; a title the spec never names is flagged as a guess', () => {
  const d = draftRole(PALANTIR);
  assert.equal(d.titleGuessed, true, 'the spec without its title line never says "Software Engineer"');
  const c = checkRole(d, { text: PALANTIR });
  assert.deepEqual(c.filter(x => x.level === 'bad'), []);
  assert.deepEqual(c.filter(x => x.level === 'warn').map(x => x.id), ['title', 'seniority']);
  const fromLink = draftRole(PALANTIR, { title: 'Software Engineer - Environment Platform' });
  assert.deepEqual(checkRole(fromLink, { text: PALANTIR }).filter(x => x.level === 'warn').map(x => x.id), ['seniority'], 'read from the link, the title is certain');
});

test('the check knows a language from a place, a stray dash and the company\'s own name', () => {
  assert.deepEqual(strayTerms('(Kubernetes OR K8s) AND (Go OR Golang) NOT recruiter'), []);
  assert.deepEqual(strayTerms('Software AND Engineer AND - AND "Environment Platform"').map(x => x.term), ['-']);
  assert.deepEqual(strayTerms('Palantir AND "Software Engineer"', { company: 'Palantir' }).map(x => x.term), ['Palantir']);
});

test('Kai\'s two live roles pass the check as they are', () => {
  const live = [
    { title: 'Senior Cloud Security Engineer', location: 'New York', workType: 'onsite', titles: ['Security Engineer', 'Senior Security Engineer'], skills: ['Cloud'], recruiterSkills: ['Azure'], domain: ['crypto'], boolean: 'Cloud AND ("Security Engineer" OR "Senior Security Engineer") AND crypto NOT recruiter' },
    { title: 'Senior IAM security Engineer', location: 'New York', workType: 'onsite', titles: ['security Engineer', 'IAM Engineer'], skills: ['IAM'], recruiterSkills: ['AWS'], domain: ['crypto'], boolean: 'IAM AND ("security Engineer" OR "IAM Engineer") AND crypto NOT recruiter' },
  ];
  for (const r of live) assert.deepEqual(checkRole({ ...r, boolean2: secondSearchFor(r) }).filter(x => x.level !== 'ok'), [], r.title);
});

// ---- learning --------------------------------------------------------------------------------------
test('what Kai changes before saving is learned: skills added and dropped, and a score over his specs', () => {
  const d = draftRole(PALANTIR);
  assert.deepEqual(score(t => draftRole(t)), { right: 0, of: 0 });
  // Kai adds "grpc", removes "infrastructure", and keeps the title
  const final = { title: d.title, suggestedSkills: [...d.skills.filter(w => w !== 'infrastructure'), 'grpc'], skills: [] };
  const lesson = recordLesson({ text: PALANTIR, guess: d, final });
  assert.deepEqual(lesson.added, ['grpc']);
  assert.deepEqual(lesson.removed, ['infrastructure']);
  assert.equal(lesson.titleRight, true);
  assert.deepEqual(vocab(), { learned: ['grpc'], dropped: ['infrastructure'] });
  // the next draft of a spec like it uses what was learned
  const next = draftRole(PALANTIR + '\nWe use gRPC between services.', {}, vocab());
  assert.ok(next.skills.includes('grpc'));
  assert.ok(!next.skills.includes('infrastructure'));
  // a title Kai corrected counts against the score until the reader gets it right
  recordLesson({ text: 'Exciting opportunity!\nJoin our team in Dubai.', guess: { title: 'Dubai' }, final: { title: 'Head of Growth' } });
  assert.deepEqual(score(t => draftRole(t)), { right: 1, of: 2 });
  const s = summary(t => draftRole(t, {}, vocab()));
  assert.deepEqual(s.learned, ['grpc']);
  assert.deepEqual(s.dropped, ['infrastructure']);
  assert.deepEqual(s.titleFixes, [{ was: 'Dubai', now: 'Head of Growth' }]);
});

test('a word added as often as it is dropped is neither learned nor dropped', () => {
  recordLesson({ text: 'x y', guess: { title: 'A', skills: ['grpc'] }, final: { title: 'A', suggestedSkills: [] } });
  assert.ok(!vocab().learned.includes('grpc') && !vocab().dropped.includes('grpc'));
});

// The real text the Lever link gives (saved 24 Sep 2026). It first made "Distributed Systems" the key
// skill, then "Go" (every English "go" counted, and "K8s" did not count for Kubernetes).
test('the Palantir job read from its Lever link: Kubernetes is the key skill, and Go or Java is either-or', () => {
  const text = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/spec-palantir-lever.txt'), 'utf8');
  const d = draftRole(text, { title: 'Software Engineer - Environment Platform', location: 'New York, NY', workType: 'hybrid', company: 'Palantir' });
  assert.deepEqual(d.recruiterSkills, ['Kubernetes']);
  assert.match(d.boolean, /AND \(Kubernetes OR K8s\) NOT/);
  assert.match(d.boolean2, /^\(Kubernetes OR K8s\) AND \(Go OR Golang OR Java\) AND /);
  const goFirst = draftRole('Backend Engineer\nWe write Go. Golang services, some Python. Go live weekly.');
  assert.deepEqual(goFirst.recruiterSkills, ['Go']);
  assert.match(goFirst.boolean2, /^\(Go OR Golang OR Python\) AND /, 'a language key skill sits with the other languages, not beside them');
  assert.deepEqual(draftRole('Head of Sales\nWe go to market fast and go live weekly.').recruiterSkills, [], 'the English word "go" is not a skill');
});

test('R and C are languages, not stray characters', async () => {
  const { strayTerms } = await import('../src/rolecheck.js');
  assert.deepEqual(strayTerms('("Data Scientist") AND (R OR Python)'), []);
  assert.deepEqual(strayTerms('("Data Scientist") AND (x OR Python)').map(x => x.term), ['x']);
});
