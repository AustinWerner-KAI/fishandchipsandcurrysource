import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const { Store } = await import('../src/store.js');
const { runConnect } = await import('../src/actions/connect.js');
const { runMessages, dueMessage, sweepReplies } = await import('../src/actions/followup.js');
const { importLeads, exportCsv, approveLeads, queueMessages, parseCsv } = await import('../src/actions/import.js');

const cfg = {
  name: 'c1', mode: 'newbusiness', autoApprove: false, noteMaxLength: 300,
  connectionNotes: ['Hey {firstName}, would be great to connect.'],
  followUps: [], dailyCaps: { connects: 2, messages: 2, profileViews: 10 },
  workingHours: { timezone: 'Asia/Dubai' }, pauseBetweenActionsSec: [0, 0],
};

function fresh() {
  const s = new Store(path.join(home, `db-${Math.random()}.json`));
  s.data.meta.ownName = 'Kai Crayford';
  return s;
}

test('connect only touches approved leads and stops at the cap', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/a', name: 'Ann A', campaign: 'c1', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/b', name: 'Bob B', campaign: 'c1', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/c', name: 'Cat C', campaign: 'c1', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/d', name: 'Dan D', campaign: 'c1' }); // not approved
  const sent = [];
  const ops = { sendConnectionRequest: async (page, url, note) => { sent.push({ url, note }); return { result: 'sent', info: {} }; } };
  const r = await runConnect(null, s, cfg, { ops, pause: false });
  assert.equal(r.sent, 2);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].note, 'Hey Ann, would be great to connect.');
  assert.equal(s.get('linkedin.com/in/a').status, 'invited');
  assert.equal(s.get('linkedin.com/in/c').status, 'new');
  assert.equal(s.get('linkedin.com/in/d').status, 'new');
  // second pass: cap already used up today
  const r2 = await runConnect(null, s, cfg, { ops, pause: false });
  assert.equal(r2.sent, 0);
});

test('connect handles LinkedIn outcomes', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/x', name: 'X', campaign: 'c1', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/y', name: 'Y', campaign: 'c1', approved: true });
  const results = { 'https://www.linkedin.com/in/x/': 'already-connected', 'https://www.linkedin.com/in/y/': 'weekly-limit' };
  const ops = { sendConnectionRequest: async (p, url) => ({ result: results[url], info: {} }) };
  const r = await runConnect(null, s, { ...cfg, dailyCaps: { ...cfg.dailyCaps, connects: 10 } }, { ops, pause: false });
  assert.equal(s.get('linkedin.com/in/x').status, 'accepted');
  assert.equal(r.weeklyLimit, true);
  assert.equal(s.get('linkedin.com/in/y').status, 'new');
});

test('checkpoint errors bubble up and stop the run', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/x', campaign: 'c1', approved: true });
  const err = new Error('checkpoint'); err.name = 'CheckpointError';
  const ops = { sendConnectionRequest: async () => { throw err; } };
  await assert.rejects(() => runConnect(null, s, cfg, { ops, pause: false }), /checkpoint/);
});

test('dueMessage: queue first, then template steps by day', () => {
  const now = new Date('2026-09-22T06:00:00Z');
  const cand = { ...cfg, mode: 'candidates', followUps: [{ afterDays: 0, text: 'hi {firstName}' }, { afterDays: 3, text: 'again' }] };
  const lead = { status: 'accepted', queue: [], messages: [], acceptedAt: '2026-09-22T05:00:00Z', firstName: 'Ann' };
  assert.deepEqual(dueMessage(lead, cand, now), { text: 'hi Ann', source: 'step', stepIndex: 0 });
  lead.messages.push({ at: '2026-09-22T05:30:00Z' }); lead.status = 'messaged';
  assert.equal(dueMessage(lead, cand, now), null); // step 2 not due for 3 days
  assert.equal(dueMessage(lead, cand, new Date('2026-09-26T06:00:00Z')).text, 'again');
  lead.queue.push({ text: 'custom', notBefore: '2026-09-23T00:00:00Z' });
  assert.equal(dueMessage(lead, cand, now), null); // queued but not yet
  assert.equal(dueMessage(lead, cand, new Date('2026-09-23T01:00:00Z')).text, 'custom');
  // new business mode never sends templates
  assert.equal(dueMessage({ ...lead, queue: [] }, cfg, new Date('2026-09-30')), null);
  assert.equal(dueMessage({ ...lead, status: 'replied' }, cand, new Date('2026-09-30')), null);
});

test('messages: sends queued text, detects replies, respects cap', async () => {
  const s = fresh();
  const a = s.upsertLead({ url: 'linkedin.com/in/a', name: 'Ann A', campaign: 'c1' });
  const b = s.upsertLead({ url: 'linkedin.com/in/b', name: 'Bob B', campaign: 'c1' });
  const c = s.upsertLead({ url: 'linkedin.com/in/c', name: 'Cat C', campaign: 'c1' });
  for (const l of [a, b, c]) s.setStatus(l.url, 'accepted', { acceptedAt: '2026-09-20T00:00:00Z' });
  a.queue.push({ text: 'Thanks for connecting Ann. How are you finding the market?' });
  b.queue.push({ text: 'Hi Bob' });
  c.queue.push({ text: 'Hi Cat' });
  const sent = [];
  const ops = {
    readOwnName: async () => 'Kai Crayford',
    openThread: async (p, url) => url.includes('/b/')
      ? { opened: true, lastFrom: 'them', lastText: 'Hey Kai, all good thanks, how about you?', editor: {} }
      : { opened: true, lastFrom: 'me', editor: {} },
    sendMessageInOpenThread: async (p, e, text) => { sent.push(text); return true; },
    closeThread: async () => {},
  };
  const r = await runMessages(null, s, cfg, { ops, pause: false });
  assert.equal(r.sent, 2);
  assert.equal(s.get(a.url).status, 'messaged');
  assert.equal(s.get(a.url).queue.length, 0);
  assert.equal(s.get(a.url).messages[0].text, 'Thanks for connecting Ann. How are you finding the market?');
  assert.equal(s.get(b.url).status, 'replied');
  assert.match(s.get(b.url).lastReply, /all good/);
  assert.equal(s.get(b.url).queue.length, 1); // never sent
  assert.equal(s.get(c.url).status, 'messaged');
  const r2 = await runMessages(null, s, cfg, { ops, pause: false });
  assert.equal(r2.sent, 0); // cap of 2 used
});

test('reply sweep finds replies on quiet threads', async () => {
  const s = fresh();
  const a = s.upsertLead({ url: 'linkedin.com/in/a', name: 'Ann A', campaign: 'c1' });
  s.setStatus(a.url, 'messaged');
  a.messages.push({ text: 'hi', at: '2026-09-20T00:00:00Z' });
  const ops = { readOwnName: async () => 'Kai', openThread: async () => ({ opened: true, lastFrom: 'them', lastText: 'yes' }), closeThread: async () => {} };
  const n = await sweepReplies(null, s, cfg, { ops, pause: false });
  assert.equal(n, 1);
  assert.equal(s.get(a.url).status, 'replied');
});

test('import, approve, queue, export', () => {
  const s = fresh();
  const txt = path.join(home, 'urls.txt');
  fs.writeFileSync(txt, 'https://www.linkedin.com/in/one/\nlinkedin.com/in/two\nnot a url\n');
  assert.deepEqual(importLeads(s, cfg, txt), { added: 2, skipped: 1 });
  const csv = path.join(home, 'leads.csv');
  fs.writeFileSync(csv, 'url,name,headline\nhttps://www.linkedin.com/in/three/,"Three, T","Head of ""Talent"""\n');
  assert.deepEqual(importLeads(s, cfg, csv), { added: 1, skipped: 0 });
  assert.equal(s.get('linkedin.com/in/three').headline, 'Head of "Talent"');
  assert.equal(s.get('linkedin.com/in/three').firstName, 'Three');
  assert.equal(approveLeads(s, cfg, '--all'), 3);
  const q = path.join(home, 'q.json');
  fs.writeFileSync(q, JSON.stringify([{ url: 'linkedin.com/in/one', text: 'Hey', note: 'builds an L2' }]));
  assert.equal(queueMessages(s, cfg, q), 1);
  assert.equal(s.get('linkedin.com/in/one').notes, 'builds an L2');
  fs.writeFileSync(q, JSON.stringify([{ url: 'linkedin.com/in/one', text: 'Hey — no' }]));
  assert.throws(() => queueMessages(s, cfg, q), /dash/);
  const out = exportCsv(s, cfg);
  assert.equal(out.split('\n').length, 5); // header + 3 rows + trailing newline
  assert.match(out, /"Three, T"/);
  assert.deepEqual(parseCsv(['a,b', '1,"x,y"']), [{ a: '1', b: 'x,y' }]);
});
