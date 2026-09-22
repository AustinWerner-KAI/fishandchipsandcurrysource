import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const cdir = path.join(home, 'campaigns'); fs.mkdirSync(cdir);
process.env.SOURCER_CAMPAIGNS = cdir;
// two roles, two clients: people at either are never contacted, whichever role they turn up in
fs.writeFileSync(path.join(cdir, 'role-a.json'), JSON.stringify({ mode: 'candidates', role: { title: 'Security Engineer', client: { name: 'Kraken', url: 'https://www.linkedin.com/company/krakenfx/', otherNames: ['Payward'] } } }));
fs.writeFileSync(path.join(cdir, 'role-b.json'), JSON.stringify({ mode: 'candidates', role: { title: 'CFO', client: { name: 'Acme Labs Ltd' } } }));
const { Store } = await import('../src/store.js');
const { allClients, offLimits, matchClient } = await import('../src/offlimits.js');
const { runConnect } = await import('../src/actions/connect.js');
const { runMessages } = await import('../src/actions/followup.js');
const { loadCampaign } = await import('../src/config.js');

const cfg = { name: 'role-a', mode: 'candidates', connectionNotes: ['Hey {firstName}'], noteMaxLength: 300, followUps: [], dailyCaps: { connects: 10, messages: 10, profileViews: 50 }, workingHours: null, pauseBetweenActionsSec: [0, 0], firstDegree: { message: 'Hi {firstName}', followUpAfterDays: 4, followUp: 'x' } };

test('client matching: name, other names, company page, headline', () => {
  const clients = allClients();
  assert.deepEqual(clients.map(c => c.name).sort(), ['Acme Labs Ltd', 'Kraken']);
  const hit = h => offLimits({ headline: h }, clients)?.name || null;
  assert.equal(hit('Senior Security Engineer at Kraken'), 'Kraken');
  assert.equal(hit('Security @ Kraken Digital Asset Exchange | ex-Coinbase'), 'Kraken');
  assert.equal(hit('Engineer at Payward, Inc.'), 'Kraken');
  assert.equal(hit('Finance Director at Acme Labs'), 'Acme Labs Ltd');
  assert.equal(hit('ex-Kraken, now Security Engineer at Coinbase'), null);   // only the current company counts
  assert.equal(hit('Security Engineer at Krakenly'), null);
  assert.equal(offLimits({ company: 'Kraken' }, clients)?.name, 'Kraken');
  assert.equal(matchClient(clients, { companyUrl: 'https://www.linkedin.com/company/krakenfx/life/' })?.name, 'Kraken');
});

test('nobody at a client is invited or messaged, even when approved or found only on their profile', async () => {
  const s = new Store();
  s.upsertLead({ url: 'linkedin.com/in/at-kraken', name: 'Ann Kay', headline: 'Security Engineer at Kraken', campaign: 'role-a', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/hidden', name: 'Hal Ide', headline: 'Security Engineer', campaign: 'role-a', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/ok', name: 'Olive Kay', headline: 'Security Engineer at Coinbase', campaign: 'role-a', approved: true });
  const d = s.upsertLead({ url: 'linkedin.com/in/first-acme', name: 'Fay Irst', headline: 'CFO at Acme Labs', campaign: 'role-a', degree: '1st' });
  s.setStatus(d.url, 'accepted', { preexisting: true, acceptedAt: '2026-09-20T00:00:00Z', direct: { at: '2026-09-20T00:00:00Z' } });
  s.save();
  const invited = [];
  const ops = { sendConnectionRequest: async (p, url, note, { clients }) => {
    // the profile shows the current company only once opened
    if (url.includes('hidden')) { const c = matchClient(clients, { companyUrl: 'https://www.linkedin.com/company/krakenfx/' }); if (c) return { result: 'off-limits', info: {}, client: c }; }
    invited.push(url); return { result: 'sent', info: {} };
  } };
  await runConnect(null, s, cfg, { ops, pause: false });
  assert.deepEqual(invited, ['https://www.linkedin.com/in/ok/']);
  assert.equal(s.get('linkedin.com/in/hidden').status, 'skipped');
  assert.equal(s.get('linkedin.com/in/hidden').offLimits, 'Kraken');
  assert.equal(s.get('linkedin.com/in/at-kraken').status, 'new');       // never touched, shown under Closed
  let opened = 0;
  await runMessages(null, s, cfg, { ops: { readOwnName: async () => 'Kai Crayford', openThread: async () => { opened++; return { opened: false }; }, closeThread: async () => {} }, pause: false });
  assert.equal(opened, 0);
  assert.equal(s.get('linkedin.com/in/first-acme').offLimits, 'Acme Labs Ltd');
});

test('a client link that is not a LinkedIn company page is refused', () => {
  fs.writeFileSync(path.join(cdir, 'bad.json'), JSON.stringify({ mode: 'candidates', role: { title: 'X', client: { name: 'X', url: 'https://kraken.com' } } }));
  assert.throws(() => loadCampaign('bad'), /company page/);
  fs.rmSync(path.join(cdir, 'bad.json'));
});
