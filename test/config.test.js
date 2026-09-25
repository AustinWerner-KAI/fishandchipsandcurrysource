import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const dir = path.join(home, 'campaigns');
fs.mkdirSync(dir);
process.env.SOURCER_CAMPAIGNS = dir;
const { loadCampaign, listCampaigns } = await import('../src/config.js');

test('example campaigns validate', () => {
  fs.copyFileSync(path.join(process.cwd(), 'campaigns', 'examples', 'newbusiness.json'), path.join(dir, 'example.json'));
  fs.copyFileSync(path.join(process.cwd(), 'campaigns', 'examples', 'candidates.json'), path.join(dir, 'candidates-example.json'));
  assert.deepEqual(listCampaigns().sort(), ['candidates-example', 'example']);
  const c = loadCampaign('example');
  assert.equal(c.mode, 'newbusiness');
  assert.equal(c.dailyCaps.connects, 12);
  assert.equal(c.workingHours.timezone, 'America/New_York');
  const k = loadCampaign('candidates-example');
  assert.equal(k.followUps.length, 2);
});

test('bad configs are rejected', () => {
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ dailyCaps: { connects: 100 }, connectionNotes: ['x'.repeat(400)] }));
  assert.throws(() => loadCampaign('bad'), /connects above 25/);
  assert.throws(() => loadCampaign('bad'), /connection note over 300/);
  assert.throws(() => loadCampaign('missing'), /No campaign file/);
  fs.writeFileSync(path.join(dir, 'bad-inmail.json'), JSON.stringify({
    inmail: { afterDays: 0, followUpAfterDays: 31, monthlyCredits: 151, perDay: 51, subject: 'x', body: 'x', followUp: 'x' },
  }));
  assert.throws(() => loadCampaign('bad-inmail'), /InMail: wait must be a whole number from 1 to 30 days/);
});

test('campaign patches preserve current fields and invalid patches preserve disk', async () => {
  const { patchCampaign } = await import('../src/config.js');
  patchCampaign('transaction', { role: { title: 'Original', geo: {} } });
  patchCampaign('transaction', { role: { title: 'Edited', geo: {} } });
  patchCampaign('transaction', raw => ({ role: { ...raw.role, geo: { london: '123' } } }));
  assert.equal(loadCampaign('transaction').role.title, 'Edited');
  assert.deepEqual(loadCampaign('transaction').role.geo, { london: '123' });
  const before = fs.readFileSync(path.join(dir, 'transaction.json'), 'utf8');
  assert.throws(() => patchCampaign('transaction', { dailyCaps: { connects: 999 } }));
  assert.equal(fs.readFileSync(path.join(dir, 'transaction.json'), 'utf8'), before);
});
