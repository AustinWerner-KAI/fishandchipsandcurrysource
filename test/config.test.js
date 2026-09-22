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
});
