import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const cdir = path.join(home, 'campaigns'); fs.mkdirSync(cdir);
process.env.SOURCER_CAMPAIGNS = cdir;
fs.copyFileSync(path.join(process.cwd(), 'campaigns', 'examples', 'newbusiness.json'), path.join(cdir, 'example.json'));
const { createApp } = await import('../src/app.js');
const { Store } = await import('../src/store.js');
const { Jobs } = await import('../src/jobs.js');

const jobs = new Jobs();
const server = createApp({ jobs });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const get = p => fetch(base + p).then(r => r.json());
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ status: r.status, body: await r.json() }));

test('page and state', async () => {
  const html = await fetch(base + '/').then(r => r.text());
  assert.match(html, /<title>Sourcer<\/title>/);
  const s = await get('/api/state?c=example');
  assert.equal(s.campaign, 'example');
  assert.equal(s.cfg.mode, 'newbusiness');
  assert.equal(s.job.running, false);
  assert.equal(s.leads.length, 0);
});

test('import, approve, status, queue, unqueue', async () => {
  let r = await post('/api/import', { campaign: 'example', text: 'https://www.linkedin.com/in/ann/\nhttps://www.linkedin.com/in/bob/\nnope' });
  assert.deepEqual(r.body, { added: 2, skipped: 1 });
  r = await post('/api/approve', { urls: ['https://www.linkedin.com/in/ann/', 'https://www.linkedin.com/in/bob/'], approved: true });
  assert.equal(r.body.n, 2);
  r = await post('/api/status', { url: 'https://www.linkedin.com/in/bob/', status: 'accepted' });
  assert.equal(r.status, 200);
  r = await post('/api/queue', { campaign: 'example', items: [{ url: 'https://www.linkedin.com/in/bob/', text: 'Thanks for connecting Bob. How is the market treating you?', note: 'route: pulse' }] });
  assert.equal(r.body.n, 1);
  r = await post('/api/queue', { campaign: 'example', items: [{ url: 'https://www.linkedin.com/in/bob/', text: 'bad — dash' }] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /dash/);
  const s = await get('/api/state?c=example');
  const bob = s.leads.find(l => l.url.includes('/bob/'));
  assert.equal(bob.status, 'accepted');
  assert.equal(bob.queued, 1);
  assert.equal(bob.notes, 'route: pulse');
  r = await post('/api/unqueue', { url: 'https://www.linkedin.com/in/bob/', index: 0 });
  assert.equal(new Store().get('https://www.linkedin.com/in/bob/').queue.length, 0);
  r = await post('/api/status', { url: 'https://www.linkedin.com/in/bob/', status: 'nonsense' });
  assert.equal(r.status, 400);
});

test('campaign settings are validated and rolled back on error', async () => {
  let r = await post('/api/campaign', { name: 'example', config: { dailyCaps: { connects: 99 } } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /above 25/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cdir, 'example.json'))).dailyCaps.connects, 12); // untouched
  r = await post('/api/campaign', { name: 'example', config: { dailyCaps: { connects: 8, messages: 10, profileViews: 30 }, connectionNotes: ['Hey {firstName}, good to connect.'] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.cfg.dailyCaps.connects, 8);
  r = await post('/api/campaign', { name: 'bad name!', config: {} });
  assert.equal(r.status, 400);
  r = await post('/api/campaign', { name: 'second', config: { mode: 'newbusiness', connectionNotes: ['hi {firstName}'] } });
  assert.equal(r.status, 200);
  assert.deepEqual((await get('/api/state')).campaigns.sort(), ['example', 'second']);
  const bad = await post('/api/campaign', { name: 'third', config: { mode: 'wrong' } });
  assert.equal(bad.status, 400);
  assert.equal(fs.existsSync(path.join(cdir, 'third.json')), false); // a new bad campaign leaves no file behind
});

test('jobs: unknown action rejected, one at a time, stop works', async () => {
  let r = await post('/api/job', { action: 'bogus' });
  assert.equal(r.status, 400);
  r = await post('/api/job', { action: 'run', campaign: 'example' });   // runs cli.js run example: fails fast (not logged in) but exercises the plumbing
  assert.equal(r.body.running, true);
  const dup = await post('/api/job', { action: 'search', campaign: 'example' });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /already running/);
  await post('/api/job', { action: 'stop' });
  for (let i = 0; i < 40 && jobs.status().running; i++) await new Promise(res => setTimeout(res, 250));
  assert.equal(jobs.status().running, false);
  const log = await get('/api/log?since=0');
  assert.ok(log.lines.some(l => /run example started/.test(l.text)));
  assert.ok(log.lines.some(l => /finished/.test(l.text)));
});

test.after(() => server.close());

test('role wizard: draft, boolean, save creates a candidates campaign, search url', async () => {
  let r = await post('/api/role/draft', { text: 'Head of Compliance\nLocation: Dubai, UAE (hybrid)\nA licensed digital asset exchange. AML, VARA.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.draft.title, 'Head of Compliance');
  assert.equal(r.body.draft.workType, 'hybrid');
  r = await post('/api/role/draft', { file: { name: 'spec.txt', base64: Buffer.from('Senior Rust Engineer\nFully remote, Europe.').toString('base64') } });
  assert.equal(r.body.draft.workType, 'remote');
  r = await post('/api/role/boolean', { title: 'Head of Compliance', domain: ['crypto'], skills: ['aml'], exclude: ['recruiter'] });
  assert.match(r.body.boolean, /^aml AND \("Head of Compliance" OR .*\) AND crypto NOT recruiter$/);
  const role = { title: 'Head of Compliance', location: 'Dubai, UAE', workType: 'hybrid', candidateLocations: ['Dubai, UAE'], titles: ['Head of Compliance'], domain: ['crypto'], skills: [], exclude: ['recruiter'], boolean: '"Head of Compliance" AND crypto NOT recruiter' };
  r = await post('/api/role/save', { role });
  assert.equal(r.status, 200);
  assert.equal(r.body.campaign, 'head-of-compliance-dubai-uae');
  assert.equal(r.body.cfg.mode, 'candidates');
  assert.equal(r.body.cfg.searchUrl, '');
  assert.match(r.body.cfg.followUps[0].text, /The \{role\} role is in \{location\}/);
  assert.match(r.body.cfg.connectionNotes[0], /new role, \{role\}, you might like/);
  assert.deepEqual(r.body.preview.locations, [{ name: 'Dubai, UAE', known: false }]);
  assert.equal(new URL(r.body.preview.url).searchParams.get('keywords'), role.boolean);
  // remote: candidate locations drive the search, known countries resolve without the browser
  r = await post('/api/role/save', { campaign: 'head-of-compliance-dubai-uae', role: { ...role, workType: 'remote', candidateLocations: ['UAE', 'United Kingdom'] } });
  assert.deepEqual(r.body.preview.locations.map(l => l.known), [true, true]);
  assert.equal(new URL(r.body.preview.url).searchParams.get('geoUrn'), '["104305776","101165590"]');
  r = await post('/api/role/save', { role: { title: '', boolean: 'x' } });
  assert.equal(r.status, 400);
  const s = await get('/api/state?c=head-of-compliance-dubai-uae');
  assert.equal(s.cfg.role.title, 'Head of Compliance');
  assert.ok(s.rolePreview.url.startsWith('https://www.linkedin.com/search/results/people/'));
});

test('search url for a role without a browser: known ids, country fallback, remembered', async () => {
  const { urlForRole } = await import('../src/actions/search.js');
  const { loadCampaign } = await import('../src/config.js');
  await post('/api/role/save', { campaign: 'head-of-compliance-dubai-uae', role: { title: 'Head of Compliance', location: 'Dubai, UAE', workType: 'hybrid', candidateLocations: ['Dubai, UAE'], boolean: '"Head of Compliance" AND crypto' } });
  const url = await urlForRole(null, loadCampaign('head-of-compliance-dubai-uae'));
  assert.equal(new URL(url).searchParams.get('geoUrn'), '["104305776"]');
  // the country stand-in is not remembered, so the city is asked for again next time
  assert.deepEqual(loadCampaign('head-of-compliance-dubai-uae').role.geo, {});
  await post('/api/role/save', { campaign: 'head-of-compliance-dubai-uae', role: { title: 'Head of Compliance', location: 'UAE', workType: 'onsite', candidateLocations: ['UAE'], boolean: 'x' } });
  await urlForRole(null, loadCampaign('head-of-compliance-dubai-uae'));
  assert.deepEqual(loadCampaign('head-of-compliance-dubai-uae').role.geo, { 'uae': '104305776' });
});

test('role save: timezone follows the office, message 1 waits 3 hours, InMail lane lists non-accepts after 7 days', async () => {
  const { inmailList } = await import('../src/app.js');
  const { loadCampaign } = await import('../src/config.js');
  const { dueMessage } = await import('../src/actions/followup.js');
  let r = await post('/api/role/save', { role: { title: 'Head of Sales', location: 'London, UK', workType: 'onsite', candidateLocations: ['London, UK'], boolean: '"Head of Sales"' } });
  assert.equal(r.body.cfg.workingHours.timezone, 'Europe/London');
  assert.equal(r.body.cfg.followUps[0].afterHours, 3);
  assert.equal(r.body.cfg.inmail.afterDays, 7);
  const cfg = loadCampaign(r.body.campaign);
  // message 1: not due 1 hour after accept, due after 4 hours
  const lead = { status: 'accepted', acceptedAt: new Date(Date.now() - 3600e3).toISOString(), messages: [], queue: [], firstName: 'Sam' };
  assert.equal(dueMessage(lead, cfg), null);
  lead.acceptedAt = new Date(Date.now() - 4 * 3600e3).toISOString();
  assert.match(dueMessage(lead, cfg).text, /^Thanks for connecting Sam\. The Head of Sales role is in London, UK, On site\./);
  // InMail lane
  await post('/api/import', { campaign: r.body.campaign, text: 'https://www.linkedin.com/in/old-invite/\nhttps://www.linkedin.com/in/fresh-invite/' });
  const store = new Store();
  store.setStatus('https://www.linkedin.com/in/old-invite/', 'invited', { invitedAt: new Date(Date.now() - 8 * 86400e3).toISOString() });
  store.setStatus('https://www.linkedin.com/in/fresh-invite/', 'invited', { invitedAt: new Date().toISOString() });
  store.get('https://www.linkedin.com/in/old-invite/').firstName = 'Ola';
  store.save();
  let list = inmailList(new Store(), cfg);
  assert.deepEqual(list.map(x => [x.url, x.kind]), [['https://www.linkedin.com/in/old-invite/', 'inmail']]);
  assert.equal(list[0].subject, 'Head of Sales, London, UK');
  assert.match(list[0].text, /^Hi Ola,\n\nI'm running a search for a Head of Sales/);
  r = await post('/api/inmail-sent', { url: 'https://www.linkedin.com/in/old-invite/', kind: 'inmail' });
  assert.equal(r.status, 200);
  assert.deepEqual(inmailList(new Store(), cfg), []);                        // follow-up not due yet
  const s2 = new Store(); s2.get('https://www.linkedin.com/in/old-invite/').inmail.sentAt = new Date(Date.now() - 5 * 86400e3).toISOString(); s2.save();
  list = inmailList(new Store(), cfg);
  assert.equal(list[0].kind, 'followUp');
  await post('/api/inmail-sent', { url: 'https://www.linkedin.com/in/old-invite/', kind: 'followUp' });
  assert.deepEqual(inmailList(new Store(), cfg), []);                        // lane over
  const st = await get(`/api/state?c=${r.body.campaign || 'head-of-sales-london-uk'}`);
  assert.ok('open' in st.hours);
});
