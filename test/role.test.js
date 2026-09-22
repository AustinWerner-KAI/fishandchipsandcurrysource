import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftRole, titleVariants, buildBoolean, buildSearchUrl, lookupGeo, slugFor, guessWorkType, guessLocation, widenBoolean, splitTitle } from '../src/role.js';

const SPEC = `Head of Compliance
Location: Dubai, UAE (hybrid)

We are a licensed digital asset exchange looking for a Head of Compliance to lead our regulatory work with VARA.
You will own AML and KYC frameworks, licensing, and the relationship with regulators.
Requirements: 8+ years compliance experience in crypto or fintech, VARA or FCA background, strong AML knowledge.`;

test('draft reads title, location, work type, domain and skills from a spec', () => {
  const d = draftRole(SPEC);
  assert.equal(d.title, 'Head of Compliance');
  assert.equal(d.location, 'Dubai, UAE');
  assert.equal(d.workType, 'hybrid');
  assert.deepEqual(d.candidateLocations, ['Dubai, UAE']);
  assert.ok(d.titles.includes('Compliance Director'));
  assert.ok(d.domain.includes('crypto'));
  assert.ok(d.skills.includes('aml'));
  assert.match(d.boolean, /^\("Head of Compliance" OR .*\) AND \(crypto OR "digital asset" OR blockchain OR web3 OR fintech OR startup\) NOT \(recruiter OR "talent acquisition" OR headhunter\)$/);
  assert.doesNotMatch(d.boolean, /aml/, 'skills are suggestions, not in the first boolean');
});

test('remote and onsite are told apart', () => {
  assert.equal(guessWorkType('Senior Rust Engineer. Fully remote, Europe time zones.'), 'remote');
  assert.equal(guessWorkType('Sales Director. On-site in London.'), 'onsite');
  assert.equal(guessWorkType('Sales Director. Hybrid, 3 days in the London office.'), 'hybrid');
  assert.equal(guessLocation('Sales Director based in Singapore, reporting to the CEO.'), 'Singapore');
});

test('title variants stay simple', () => {
  assert.deepEqual(titleVariants('Head of Compliance'), ['Head of Compliance', 'Compliance Director', 'Director of Compliance', 'VP Compliance', 'Compliance Lead']);
  assert.deepEqual(titleVariants('Senior Rust Engineer'), ['Rust Engineer', 'Senior Rust Engineer', 'Lead Rust Engineer', 'Principal Rust Engineer']);
  assert.ok(titleVariants('Chief Technology Officer').includes('Head of Technology'));
  assert.deepEqual(titleVariants(''), []);
});

test('compound titles: modifier becomes an AND term, core title gets the seniority variants', () => {
  assert.deepEqual(splitTitle('Senior Cloud Security Engineer'), { seniority: 'Senior', modifiers: ['Cloud'], core: 'Security Engineer' });
  assert.deepEqual(splitTitle('Senior Smart Contract Engineer').modifiers, []);
  assert.deepEqual(splitTitle('Head of Compliance').modifiers, []);
  const d = draftRole('Senior Cloud Security Engineer\nLocation: New York (hybrid)\nWe are a crypto exchange.');
  assert.equal(d.boolean, 'Cloud AND ("Security Engineer" OR "Senior Security Engineer" OR "Lead Security Engineer" OR "Principal Security Engineer") AND (crypto OR "digital asset" OR blockchain OR web3 OR fintech OR startup) NOT (recruiter OR "talent acquisition" OR headhunter)');
  assert.deepEqual(d.required, ['Cloud']);
});

test('boolean and URL', () => {
  const b = buildBoolean({ titles: ['Head of Sales'], domain: ['crypto', 'web3'], skills: ['institutional'], exclude: ['recruiter'] });
  assert.equal(b, 'institutional AND "Head of Sales" AND (crypto OR web3) NOT recruiter');
  const u = new URL(buildSearchUrl(b, ['104305776', '101165590']));
  assert.equal(u.searchParams.get('keywords'), b);
  assert.equal(u.searchParams.get('geoUrn'), '["104305776","101165590"]');
  assert.equal(new URL(buildSearchUrl(b, [])).searchParams.get('geoUrn'), null);
});

test('location lookup: exact first, country only when asked', () => {
  assert.equal(lookupGeo('UAE'), '104305776');
  assert.equal(lookupGeo('the United Kingdom'), '101165590');
  assert.equal(lookupGeo('Dubai, UAE'), null);
  assert.equal(lookupGeo('Dubai, UAE', { loose: true }), '104305776');
  assert.equal(lookupGeo('Zug'), null);
  assert.equal(slugFor('Head of Compliance', 'Dubai, UAE'), 'head-of-compliance-dubai-uae');
  assert.ok(slugFor('Chief Technology Officer for Institutional Digital Assets', 'Singapore').length + 5 <= 41);
});

test('widening loosens the boolean one step at a time', () => {
  const b = '("Senior Cloud Security Engineer" OR "Cloud Security Engineer") AND (crypto OR web3) AND aml NOT (recruiter OR "talent acquisition")';
  const w = widenBoolean(b);
  assert.deepEqual(w.map(x => x.boolean), [
    '("Senior Cloud Security Engineer" OR "Cloud Security Engineer") AND (crypto OR web3) AND aml',
    '("Senior Cloud Security Engineer" OR "Cloud Security Engineer") AND (crypto OR web3)',
    '("Senior Cloud Security Engineer" OR "Cloud Security Engineer")',
    '"Senior Cloud Security Engineer"',
  ]);
  assert.deepEqual(widenBoolean('"Head of Sales"'), []);
  assert.deepEqual(widenBoolean('"Head of Sales" NOT recruiter').map(x => x.boolean), ['"Head of Sales"']);
});

test('ranking: main title beats a keyword list, recruiters score 0, degree comes off the name', async () => {
  const { scoreLead, cleanLead } = await import('../src/rank.js');
  const role = { title: 'Senior Cloud Security Engineer', titles: ['Security Engineer', 'Senior Security Engineer', 'Lead Security Engineer'], skills: ['Cloud'], domain: ['crypto', 'fintech'], suggestedSkills: ['aws'] };
  const s = h => scoreLead({ name: 'A', headline: h }, role).score;
  assert.ok(s('Lead Cloud Security Engineer') > s('IT Cloud Security Engineer'));
  assert.ok(s('IT Cloud Security Engineer') > s('Network Engineer | Network Security Engineer | AWS Cloud'));
  assert.ok(s('Senior Cloud Security Engineer at a crypto exchange') >= 85);
  assert.equal(s('Technical Recruiter, Cloud Security'), 0);
  assert.ok(s('Cloud Security Intern') < 20);
  assert.deepEqual(cleanLead({ name: 'Edward Lee • 3rd+', headline: 'IT Cloud Security Engineer' }), { name: 'Edward Lee', degree: '3rd+', headline: 'IT Cloud Security Engineer' });
  assert.deepEqual(cleanLead({ name: 'Derek Zellefrow', headline: '• 3rd+' }), { name: 'Derek Zellefrow', degree: '3rd+', headline: '' });
  assert.equal(scoreLead({ name: 'D', headline: '• 3rd+' }, role).score, 15);
});

test('recruiter skills: two at most', async () => {
  const { recruiterSkills } = await import('../src/actions/recruiter.js');
  assert.deepEqual(recruiterSkills({ recruiterSkills: ['AWS', ' Cloud Security ', 'AWS', 'Kubernetes'] }), ['AWS', 'Cloud Security']);
  assert.deepEqual(recruiterSkills({}), []);
});
