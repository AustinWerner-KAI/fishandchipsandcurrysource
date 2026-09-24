import { test } from 'node:test';
import assert from 'node:assert/strict';
import { learnExcludes, withLearnedNot, MIN_EXCLUDED } from '../src/excludelearn.js';

const role = {
  title: 'Software Engineer', location: 'London',
  boolean: '("Software Engineer" OR "Backend Engineer") AND (Kubernetes OR K8s) NOT (recruiter OR "talent acquisition" OR headhunter)',
  recruiterSkills: ['Kubernetes'], skills: [], titles: ['Software Engineer', 'Backend Engineer'],
};
const lead = (i, headline, extra = {}) => ({ url: `https://www.linkedin.com/in/p${i}/`, name: `P ${i}`, headline, campaign: 'r', status: 'new', ...extra });
const ex = (i, headline, extra = {}) => lead(i, headline, { status: 'skipped', skippedByHand: true, ...extra });

test('three excludes sharing a word nobody kept has: both searches leave it out', () => {
  const leads = [
    ex(1, 'SAP Consultant | Kubernetes'), ex(2, 'Senior Consultant at Deloitte'), ex(3, 'Cloud Consultant, Kubernetes'),
    lead(4, 'Software Engineer at Monzo', { approved: true }), lead(5, 'Backend Engineer | Go'), lead(6, 'Platform Engineer'),
  ];
  const got = learnExcludes(leads, role);
  assert.deepEqual(got.map(x => x.term), ['consultant'], 'the word, never a phrase');
  assert.equal(got[0].n, 3);
});

test('two excludes are not enough, and a kept person with the word stops it', () => {
  assert.equal(MIN_EXCLUDED, 3);
  const two = [ex(1, 'SAP Consultant'), ex(2, 'Cloud Consultant'), lead(3, 'Software Engineer')];
  assert.deepEqual(learnExcludes(two, role), []);
  const kept = [ex(1, 'SAP Consultant'), ex(2, 'Cloud Consultant'), ex(3, 'IT Consultant'), lead(4, 'Consultant turned Engineer', { status: 'replied' })];
  assert.deepEqual(learnExcludes(kept, role).map(x => x.term), [], 'he replied-with one, so the word is not bad');
});

test('the role\'s own words, places and seniority words are never learned', () => {
  const leads = [ex(1, 'Senior Software Engineer London'), ex(2, 'Senior Software Engineer, London'), ex(3, 'Senior Software Engineer | London'), lead(4, 'Engineer')];
  assert.deepEqual(learnExcludes(leads, role), []);
});

test('a word everyone in the role has is not learned, however many excludes share it', () => {
  const leads = [ex(1, 'Java Developer'), ex(2, 'Java Developer'), ex(3, 'Java Developer'),
    ...Array.from({ length: 12 }, (_, i) => lead(10 + i, 'Java Developer and Kubernetes'))];
  assert.deepEqual(learnExcludes(leads, role).map(x => x.term), []);
});

test('the same company across excludes is learned, and Undo turns a term off', () => {
  const leads = [ex(1, 'Engineer', { company: 'Accenture' }), ex(2, 'Developer', { company: 'Accenture' }), ex(3, 'Architect', { company: 'Accenture' }), lead(4, 'Engineer', { company: 'Monzo', approved: true })];
  const got = learnExcludes(leads, role);
  assert.ok(got.find(x => x.term === 'accenture' && x.company));
  assert.equal(learnExcludes(leads, { ...role, learnedExcludeOff: ['accenture'] }).find(x => x.term === 'accenture'), undefined);
});

test('learned terms join the NOT group, once, and a boolean without one gets one', () => {
  assert.equal(withLearnedNot(role.boolean, [{ term: 'consultant' }, { term: 'sap consultant' }]),
    '("Software Engineer" OR "Backend Engineer") AND (Kubernetes OR K8s) NOT (recruiter OR "talent acquisition" OR headhunter OR consultant OR "sap consultant")');
  assert.equal(withLearnedNot('(a OR b) NOT recruiter', [{ term: 'recruiter' }]), '(a OR b) NOT recruiter', 'already there');
  assert.equal(withLearnedNot('(a OR b) NOT recruiter', [{ term: 'consultant' }]), '(a OR b) NOT (recruiter OR consultant)');
  assert.equal(withLearnedNot('(a OR b)', [{ term: 'consultant' }]), '(a OR b) NOT consultant');
  assert.equal(withLearnedNot('(a OR b)', []), '(a OR b)');
  assert.equal(withLearnedNot('', [{ term: 'x' }]), '');
});

test('never learned: pronouns, words about who someone is, plurals of the role\'s words, accent fragments', () => {
  const k = lead(9, 'Software Engineer', { approved: true });
  assert.deepEqual(learnExcludes([ex(1, 'Consultant (She/Her)'), ex(2, 'Analyst (she/her)'), ex(3, 'Advisor | She/Her'), k, lead(8, 'x')], role).map(x => x.term).filter(t => /she|her/.test(t)), []);
  assert.deepEqual(learnExcludes([ex(1, 'Head of Engineers'), ex(2, 'Engineers Guild lead'), ex(3, 'We hire engineers'), k], role).map(x => x.term).filter(t => /engineer/.test(t)), []);
  const acc = learnExcludes([ex(1, 'Ingénieur Sécurité'), ex(2, 'Ingénieur Sécurité Cloud'), ex(3, 'Ingénieur Sécurité Réseau'), k], role).map(x => x.term);
  assert.ok(acc.includes('ingenieur') && acc.includes('securite'), acc.join());
  assert.ok(!acc.some(t => ['ing', 'nieur', 'curit'].includes(t)), acc.join());
});

test('nothing learned with nobody kept, or from a word common in the rest of the role', () => {
  const three = [ex(1, 'SAP Consultant'), ex(2, 'IT Consultant'), ex(3, 'Cloud Consultant')];
  assert.deepEqual(learnExcludes([...three, lead(4, 'Engineer')], role), [], 'nobody kept yet');
  const rest = Array.from({ length: 10 }, (_, i) => lead(20 + i, i < 2 ? 'AWS Consultant' : 'Engineer'));
  assert.deepEqual(learnExcludes([...three, lead(4, 'Engineer', { approved: true }), ...rest], role), [], '2 in 11 of the rest have it');
});

test('awkward company names are quoted safely', () => {
  assert.equal(withLearnedNot('(a OR b) NOT recruiter', [{ term: 'at&t' }, { term: 'ernst & young (ey)' }, { term: 'c++' }]),
    '(a OR b) NOT (recruiter OR "at&t" OR "ernst & young ey" OR "c++")');
});
