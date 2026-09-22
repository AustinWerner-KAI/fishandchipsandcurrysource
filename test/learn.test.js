import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpHome } from './helpers.js';
tmpHome();
const { learn, adjust, rankLearned, chooseNote, noteStats, features } = await import('../src/learn.js');
const { Store } = await import('../src/store.js');

const role = { title: 'Senior Cloud Security Engineer', skills: ['Cloud'], domain: ['crypto', 'fintech'] };
const lead = (i, headline, extra = {}) => ({ url: `https://www.linkedin.com/in/p${i}/`, name: `P ${i}`, headline, status: 'new', ...extra });

test('features stay within one part of the headline', () => {
  const f = features({ headline: 'Security Engineer | Azure', degree: '2nd' });
  assert.ok(f.includes('security engineer') && f.includes('azure') && f.includes('degree:2nd'));
  assert.ok(!f.includes('engineer azure'));
});

test('learns from picks: ranks up what Kai ticks, down what he excludes; quiet until there is enough', () => {
  const few = [lead(1, 'Cloud Security Engineer | Azure', { approved: true })];
  assert.equal(learn(few, role).active, false);
  const leads = [
    ...[1, 2, 3, 4, 5, 6].map(i => lead(i, `Senior Cloud Security Engineer | Azure | Fintech ${i}`, { approved: true })),
    ...[7, 8, 9].map(i => lead(i, `Founder | Security Consultant | Partnerships ${i}`, { status: 'skipped', skippedByHand: true })),
    lead(10, 'Cloud Security Engineer | Azure'),
    lead(11, 'Founder | Security Partnerships'),
  ];
  const m = learn(leads, role);
  assert.equal(m.active, true);
  assert.ok(m.favours.includes('azure'), m.favours.join());
  assert.ok(m.marksDown.includes('founder'), m.marksDown.join());
  const up = adjust(leads[9], m), down = adjust(leads[10], m);
  assert.ok(up.points > 0 && up.points <= 15, up.points);
  assert.ok(down.points < 0 && down.points >= -15, down.points);
  assert.match(up.reasons[0], /^you pick: /);
  const ranked = rankLearned([leads[9], leads[10]], role, m);
  assert.ok(ranked[0].rank.score > ranked[1].rank.score);
  assert.ok(ranked[0].rank.reasons.some(r => r.startsWith('you pick')));
});

test('results count more than picks: replies and accepts teach, ignored invites count against', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');
  const leads = [
    ...[1, 2, 3].map(i => lead(i, `Security Engineer | Azure ${i}`, { status: 'replied', acceptedAt: '2026-10-01T00:00:00Z' })),
    ...[4, 5].map(i => lead(i, `Security Engineer | Azure ${i}`, { status: 'messaged', acceptedAt: '2026-10-01T00:00:00Z' })),
    ...[6, 7, 8].map(i => lead(i, `Security Engineer | GCP ${i}`, { status: 'invited', invitedAt: '2026-09-01T00:00:00Z' })),
  ];
  const m = learn(leads, role, now);
  assert.equal(m.replied, 3); assert.equal(m.accepted, 2);
  assert.ok(m.weights.azure > 0 && m.weights.gcp < 0);
});

test('people at a client and automatic skips teach nothing', () => {
  const leads = [...[1, 2, 3, 4, 5].map(i => lead(i, 'Security Engineer | Azure', { approved: true })),
    ...[6, 7, 8].map(i => lead(i, 'Security Engineer at Kraken', { status: 'skipped', offLimits: 'Kraken' })),
    ...[9, 10, 11].map(i => lead(i, 'Security Engineer, Vermont', { status: 'skipped', error: 'outside New York' }))];
  assert.equal(learn(leads, role).active, false);
});

test('connection notes: each gets a fair trial, then the best is sent 4 times in 5', () => {
  const notes = ['a', 'b'];
  assert.equal(chooseNote(['only'], []), 0);
  assert.equal(chooseNote(notes, [{ sent: 3 }, { sent: 1 }]), 1);
  const stats = [{ sent: 20, rate: 0.2 }, { sent: 20, rate: 0.5 }];
  let best = 0; for (let i = 0; i < 1000; i++) if (chooseNote(notes, stats, () => i / 1000) === 1) best++;
  assert.ok(best > 750 && best < 850, best);
  const s = new Store();
  const a = s.upsertLead({ url: 'linkedin.com/in/n1', campaign: 'c' }); s.setStatus(a.url, 'accepted', { acceptedAt: '2026-09-22T00:00:00Z' });
  s.upsertLead({ url: 'linkedin.com/in/n2', campaign: 'c' });
  s.recordAction('connects', a.url, { noteTemplate: 'b', campaign: 'c' });
  s.recordAction('connects', 'linkedin.com/in/n2', { noteTemplate: 'b', campaign: 'c' });
  s.recordAction('connects', 'linkedin.com/in/n2', { noteTemplate: 'a', campaign: 'other' });
  s.recordAction('connects', 'linkedin.com/in/n2', { noteTemplate: 'an old wording', campaign: 'c' });   // edited away: not counted
  assert.deepEqual(noteStats(notes, s, 'c'), [{ sent: 0, accepted: 0, rate: null }, { sent: 2, accepted: 1, rate: 0.5 }]);
});

test('automatic skips and 1st connections never count as Kai saying no', () => {
  const leads = [...[1, 2, 3, 4, 5, 6].map(i => lead(i, `Senior Security Engineer | Azure ${i}`, { approved: true })),
    ...[7, 8, 9].map(i => lead(i, 'Senior Security Engineer | Old chat', { status: 'skipped', autoSkip: true, error: 'they wrote last' })),
    ...[10, 11, 12].map(i => lead(i, 'Senior Cloud Security Engineer | Azure | Fintech', { degree: '1st' }))];
  const m = learn(leads, role);
  assert.equal(m.active, false);
  assert.equal(m.weights['degree:1st'], undefined);
});
