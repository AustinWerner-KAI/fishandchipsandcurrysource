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
