import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsMod from 'node:fs';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const { Store, normalizeUrl, firstNameOf } = await import('../src/store.js');

test('normalizeUrl handles the usual shapes', () => {
  assert.equal(normalizeUrl('linkedin.com/in/jane-doe'), 'https://www.linkedin.com/in/jane-doe/');
  assert.equal(normalizeUrl('https://www.linkedin.com/in/jane-doe/?miniProfileUrn=abc'), 'https://www.linkedin.com/in/jane-doe/');
  assert.equal(normalizeUrl('https://uk.linkedin.com/in/jane-doe/details/experience/'), 'https://www.linkedin.com/in/jane-doe/');
  assert.equal(normalizeUrl('https://www.linkedin.com/company/foo'), null);
  assert.equal(normalizeUrl(''), null);
});

test('firstNameOf', () => {
  assert.equal(firstNameOf('Jane Doe'), 'Jane');
  assert.equal(firstNameOf('Jane Doe (she/her)'), 'Jane');
  assert.equal(firstNameOf('Dr. Jane Doe, CFA'), 'Jane');
  assert.equal(firstNameOf('José Álvarez'), 'José');
  assert.equal(firstNameOf(''), '');
});

test('store round-trips and keeps status on re-upsert', () => {
  const file = path.join(home, 'db.json');
  const s = new Store(file);
  const l = s.upsertLead({ url: 'linkedin.com/in/jane-doe', name: 'Jane Doe', campaign: 'c1' });
  assert.equal(l.status, 'new');
  assert.equal(l.firstName, 'Jane');
  s.setStatus(l.url, 'invited', { invitedAt: 'x' });
  s.recordAction('connects', l.url);
  s.save();
  const s2 = new Store(file);
  const l2 = s2.upsertLead({ url: 'https://www.linkedin.com/in/jane-doe/', headline: 'CTO' });
  assert.equal(l2.status, 'invited');
  assert.equal(l2.headline, 'CTO');
  assert.equal(s2.actionsSince('2000-01-01', 'connects').length, 1);
  assert.equal(s2.counts('c1').invited, 1);
  assert.throws(() => s2.setStatus(l.url, 'bogus'));
});

test('normalizeUrl rejects non-LinkedIn hosts', () => {
  assert.equal(normalizeUrl('http://127.0.0.1:4790/in/ann/'), null);
  assert.equal(normalizeUrl('https://evil.com/in/ann/'), null);
});

test('corrupt db is an error, not a silent wipe; missing db is fine', () => {
  const file = path.join(home, 'bad.json');
  require_fs().writeFileSync(file, '{ not json');
  assert.throws(() => new Store(file), /JSON/);
  const s = new Store(path.join(home, 'nope.json'));
  assert.deepEqual(Object.keys(s.data.leads), []);
});

test('two writers never lose each other\'s changes when each reloads before writing', () => {
  const file = path.join(home, 'shared.json');
  const a = new Store(file);
  a.upsertLead({ url: 'linkedin.com/in/one', campaign: 'c' });
  a.upsertLead({ url: 'linkedin.com/in/two', campaign: 'c' });
  a.save();
  const b = new Store(file);
  b.get('linkedin.com/in/two').approved = true; b.save();     // dashboard ticks approval
  a.refresh(); a.setStatus('linkedin.com/in/one', 'invited'); a.save();   // runner records an invite
  const check = new Store(file);
  assert.equal(check.get('linkedin.com/in/one').status, 'invited');
  assert.equal(check.get('linkedin.com/in/two').approved, true);
  assert.equal(require_fs().existsSync(file + '.lock'), false);
});

function require_fs() { return fsMod; }

test('audit: a save from a stale copy keeps changes another process made meanwhile', () => {
  const file = path.join(home, 'merge.json');
  const runner = new Store(file);
  runner.upsertLead({ url: 'linkedin.com/in/m1', campaign: 'c' });
  runner.upsertLead({ url: 'linkedin.com/in/m2', campaign: 'c' });
  runner.save();
  const app = new Store(file);
  app.get('linkedin.com/in/m2').approved = true;
  app.get('linkedin.com/in/m1').notes = 'keep';
  app.recordAction('inmail', 'linkedin.com/in/m2');
  app.save();
  // runner never reloaded: its copy is stale
  runner.get('linkedin.com/in/m1').status = 'invited';
  runner.recordAction('connects', 'linkedin.com/in/m1');
  runner.save();
  const check = new Store(file);
  assert.equal(check.get('linkedin.com/in/m1').status, 'invited');
  assert.equal(check.get('linkedin.com/in/m1').notes, 'keep');
  assert.equal(check.get('linkedin.com/in/m2').approved, true);
  assert.deepEqual(check.data.actions.map(a => a.type).sort(), ['connects', 'inmail']);
});

// 24 Sep 2026 audit: a Search in the second tab used to share the run's Store, and its reload
// threw away a reply the run had marked but not yet saved, so the next follow-up went to someone
// who had already answered. The second tab now has its own Store; this is that exact sequence.
test('a second Store sweeping alongside never loses a reply the run has not saved yet', () => {
  const file = path.join(home, `db-race-${Date.now()}.json`);
  const run = new Store(file);
  run.upsertLead({ url: 'https://www.linkedin.com/in/ann/', name: 'Ann Example', campaign: 'c1' });
  run.setStatus('https://www.linkedin.com/in/ann/', 'messaged');
  run.save();

  run.setStatus('https://www.linkedin.com/in/ann/', 'replied');      // marked, not saved yet (an await follows)
  const tab = new Store(file);                                        // the second tab's own copy
  tab.refresh();
  tab.data.finds['github:someone'] = { key: 'github:someone', name: 'Some One', campaign: 'c1' };
  tab.recordAction('profileViews', 'github:someone');
  tab.save();
  run.save();                                                         // the run's await ends, it saves

  const disk = new Store(file);
  assert.equal(disk.get('https://www.linkedin.com/in/ann/').status, 'replied', 'the reply must survive');
  assert.ok(disk.data.finds['github:someone'], 'and the second tab\'s find must survive too');
  assert.equal(disk.data.actions.filter(a => a.type === 'profileViews').length, 1,
    'the profile view the sweep spent is counted once, so the daily cap stays right');
});

test('findTwin: "Acme" is "Acme Inc.", LinkedIn Member is nobody, and an excluded name stays out whatever the company', async () => {
  const { Store } = await import('../src/store.js');
  const s = new Store();
  s.upsertLead({ url: 'https://www.linkedin.com/talent/profile/tw1', name: 'Jane Doe', company: 'Acme', campaign: 'tw' });
  s.upsertLead({ url: 'https://www.linkedin.com/talent/profile/tw2', name: 'LinkedIn Member', company: '', campaign: 'tw' });
  assert.ok(s.findTwin('tw', 'Jane Doe', 'Acme Inc.'));
  assert.equal(s.findTwin('tw', 'Jane Doe', 'Globex'), null);
  assert.equal(s.findTwin('tw', 'LinkedIn Member', ''), null);
  assert.equal(s.excludedTwin('tw', 'Jane Doe'), null, 'not excluded');
  s.setStatus('https://www.linkedin.com/talent/profile/tw1', 'skipped', { skippedByHand: true });
  assert.ok(s.excludedTwin('tw', 'Dr Jane Doe, CISSP'), 'excluded: stays out under any company');
});

test('findTwin: Meta is not Metaco, and a company that is only a suffix word is compared whole', async () => {
  const { Store } = await import('../src/store.js');
  const s = new Store();
  s.upsertLead({ url: 'https://www.linkedin.com/talent/profile/mc1', name: 'Mike Chen', company: 'Meta', campaign: 'mc' });
  assert.equal(s.findTwin('mc', 'Mike Chen', 'Metaco'), null);
  assert.equal(s.findTwin('mc', 'Mike Chen', 'Group'), null);
  assert.ok(s.findTwin('mc', 'Mike Chen', 'Meta Platforms Inc') === null, 'a different legal name is a different company to a simple match');
  assert.ok(s.findTwin('mc', 'Mike Chen', 'META Ltd'));
  assert.ok(s.findTwin('mc', 'Mike Chen', ''), 'no company to compare: same name counts');
});
