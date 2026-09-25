import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const { Store } = await import('../src/store.js');
const { CheckpointError } = await import('../src/browser.js');
const { runConnect } = await import('../src/actions/connect.js');
const { runMessages, dueMessage, sweepReplies } = await import('../src/actions/followup.js');
const { weeklyLimitActive } = await import('../src/actions/connect.js');
const { importLeads, exportCsv, approveLeads, queueMessages, parseCsv } = await import('../src/actions/import.js');

const cfg = {
  name: 'c1', mode: 'newbusiness', autoApprove: false, noteMaxLength: 300,
  connectionNotes: ['Hey {firstName}, would be great to connect.'],
  followUps: [], dailyCaps: { connects: 2, messages: 2, profileViews: 10 },
  workingHours: null, pauseBetweenActionsSec: [0, 0],   // no hours: tests must pass at any time of day
};

function fresh() {
  const s = new Store(path.join(home, `db-${Math.random()}.json`));
  s.data.meta.ownName = 'Kai Crayford';
  s.save();
  return s;
}

test('connect only touches approved leads and stops at the cap', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/a', name: 'Ann A', campaign: 'c1', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/b', name: 'Bob B', campaign: 'c1', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/c', name: 'Cat C', campaign: 'c1', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/d', name: 'Dan D', campaign: 'c1' }); // not approved
  s.save();
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
  s.upsertLead({ url: 'linkedin.com/in/x', name: 'Xavier Xu', campaign: 'c1', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/y', name: 'Yara Yu', campaign: 'c1', approved: true });
  s.save();
  const results = { 'https://www.linkedin.com/in/x/': 'already-connected', 'https://www.linkedin.com/in/y/': 'weekly-limit' };
  const ops = { sendConnectionRequest: async (p, url) => ({ result: results[url], info: {} }) };
  const r = await runConnect(null, s, { ...cfg, dailyCaps: { ...cfg.dailyCaps, connects: 10 } }, { ops, pause: false });
  assert.equal(s.get('linkedin.com/in/x').status, 'new');          // back to the 1st connections list
  assert.equal(s.get('linkedin.com/in/x').degree, '1st');
  assert.equal(s.get('linkedin.com/in/x').approved, false);
  assert.equal(r.weeklyLimit, true);
  assert.equal(s.get('linkedin.com/in/y').status, 'new');
  // the weekly limit is remembered: no more connects for 7 days
  assert.equal(weeklyLimitActive(s), true);
  const r2 = await runConnect(null, s, cfg, { ops: { sendConnectionRequest: async () => { throw new Error('must not be called'); } }, pause: false });
  assert.equal(r2.sent, 0);
  assert.equal(r2.weeklyLimit, true);
});

test('connect picks up a dashboard change made mid-run', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/a', name: 'Ann A', campaign: 'c1', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/b', name: 'Bob B', campaign: 'c1', approved: true });
  s.save();
  const ops = { sendConnectionRequest: async (p, url) => {
    if (url.includes('/a/')) { // while Ann is being invited, the dashboard un-approves Bob and queues a note
      const other = new Store(s.file); other.get('linkedin.com/in/b').approved = false; other.get('linkedin.com/in/b').notes = 'hold'; other.save();
    }
    return { result: 'sent', info: {} };
  } };
  const r = await runConnect(null, s, { ...cfg, dailyCaps: { ...cfg.dailyCaps, connects: 10 } }, { ops, pause: false });
  assert.equal(r.sent, 1);
  const disk = new Store(s.file);
  assert.equal(disk.get('linkedin.com/in/a').status, 'invited');
  assert.equal(disk.get('linkedin.com/in/b').status, 'new');
  assert.equal(disk.get('linkedin.com/in/b').approved, false);
  assert.equal(disk.get('linkedin.com/in/b').notes, 'hold'); // not overwritten by the runner's stale copy
});

test('checkpoint errors bubble up and stop the run', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/x', name: 'Xavier Xu', campaign: 'c1', approved: true });
  s.save();
  const err = new CheckpointError('checkpoint');
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
  // someone who was already a contact never gets "thanks for connecting"
  assert.equal(dueMessage({ ...lead, queue: [], messages: [], status: 'accepted', preexisting: true }, cand, new Date('2026-09-30')), null);
  assert.equal(dueMessage({ ...lead, queue: [{ text: 'hand written' }], messages: [], status: 'accepted', preexisting: true }, cand, new Date('2026-09-30')).text, 'hand written');
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
  s.save();
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

test('messages: never sends twice, and stops when own name is unknown', async () => {
  const s = fresh();
  const a = s.upsertLead({ url: 'linkedin.com/in/a', name: 'Ann A', campaign: 'c1' });
  s.setStatus(a.url, 'accepted', { acceptedAt: '2026-09-20T00:00:00Z' });
  a.queue.push({ text: 'Hey Ann, how are you finding the market?' });
  s.save();
  let sends = 0;
  // thread already ends with exactly this text from us: an earlier pass sent it but could not confirm
  const ops = {
    readOwnName: async () => 'Kai Crayford',
    openThread: async () => ({ opened: true, lastFrom: 'me', lastText: 'Hey Ann, how are you finding the market?', editor: {} }),
    sendMessageInOpenThread: async () => { sends++; return true; },
    closeThread: async () => {},
  };
  const r = await runMessages(null, s, cfg, { ops, pause: false });
  assert.equal(sends, 0);
  assert.equal(r.sent, 0);
  assert.equal(s.get(a.url).status, 'messaged');
  assert.equal(s.get(a.url).queue.length, 0);
  assert.equal(s.get(a.url).messages.length, 1);

  // unknown own name: refuse to send rather than guess who spoke last
  const s2 = fresh(); s2.data.meta.ownName = ''; s2.save();
  const b = s2.upsertLead({ url: 'linkedin.com/in/b', name: 'Bob', campaign: 'c1' });
  s2.setStatus(b.url, 'accepted', { acceptedAt: '2026-09-20T00:00:00Z' }); b.queue.push({ text: 'x' }); s2.save();
  const r2 = await runMessages(null, s2, cfg, { ops: { ...ops, readOwnName: async () => '' }, pause: false });
  assert.equal(r2.sent, 0);
  assert.equal(s2.get(b.url).status, 'accepted');
});

test('reply sweep finds replies on quiet threads', async () => {
  const s = fresh();
  const a = s.upsertLead({ url: 'linkedin.com/in/a', name: 'Ann A', campaign: 'c1' });
  s.setStatus(a.url, 'messaged');
  a.messages.push({ text: 'hi', at: '2026-09-20T00:00:00Z' });
  s.save();
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
  // a replied lead stays frozen unless resume is explicit
  s.setStatus('linkedin.com/in/two', 'replied'); s.save();
  fs.writeFileSync(q, JSON.stringify([{ url: 'linkedin.com/in/two', text: 'follow' }]));
  queueMessages(s, cfg, q);
  assert.equal(s.get('linkedin.com/in/two').status, 'replied');
  fs.writeFileSync(q, JSON.stringify([{ url: 'linkedin.com/in/two', text: 'follow', resume: true }]));
  queueMessages(s, cfg, q);
  assert.equal(s.get('linkedin.com/in/two').status, 'messaged');
  const out = exportCsv(s, cfg);
  assert.equal(out.split('\n').length, 5); // header + 3 rows + trailing newline
  assert.match(out, /"Three, T"/);
  s.get('linkedin.com/in/one').notes = 'found on github, eips (github/private-handle)';
  s.save();
  const safe = exportCsv(s, cfg);
  assert.ok(!safe.includes('private-handle'));
  assert.ok(!safe.includes('found on github'));
  assert.match(safe, /found on eips/);
  assert.deepEqual(parseCsv(['a,b', '1,"x,y"']), [{ a: '1', b: 'x,y' }]);
});

test('messages: no template ever goes to someone who has written, even after Kai answered by hand', async () => {
  const s = fresh();
  const ccfg = { ...cfg, mode: 'candidates', followUps: [{ afterDays: 0, text: 'Thanks for connecting {firstName}.' }, { afterDays: 0, text: 'Just checking {firstName}.' }] };
  s.upsertLead({ url: 'linkedin.com/in/e', name: 'Eve E', campaign: 'c1' });
  s.setStatus('linkedin.com/in/e', 'messaged', { acceptedAt: new Date(Date.now() - 86400e3).toISOString() });
  s.get('linkedin.com/in/e').messages.push({ step: 0, text: 'Thanks for connecting Eve.', at: new Date(Date.now() - 86400e3).toISOString() });
  s.save();
  const sent = [];
  const ops = {
    readOwnName: async () => 'Kai Crayford',
    openThread: async () => ({ opened: true, lastFrom: 'me', lastText: 'Sure, sending it now', theySpoke: true, editor: {} }),
    sendMessageInOpenThread: async (p, e, text) => { sent.push(text); return true; },
    closeThread: async () => {},
  };
  await runMessages(null, s, ccfg, { ops, pause: false });
  assert.deepEqual(sent, []);
  assert.equal(s.get('linkedin.com/in/e').status, 'replied');
});

test('messages: Reply (a queued message with resume) sends even though they wrote last', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/f', name: 'Fay F', campaign: 'c1' });
  s.setStatus('linkedin.com/in/f', 'replied', { acceptedAt: new Date().toISOString(), lastReply: 'What is the range?' });
  s.save();
  const qf = path.join(home, `q-${Math.random()}.json`);
  fs.writeFileSync(qf, JSON.stringify([{ url: 'linkedin.com/in/f', text: 'Hi Fay, the range is on the brief.\nSending now.', resume: true }]));
  queueMessages(s, cfg, qf);
  assert.equal(s.get('linkedin.com/in/f').status, 'messaged');
  const sent = [];
  const ops = {
    readOwnName: async () => 'Kai Crayford',
    openThread: async () => ({ opened: true, lastFrom: 'them', lastText: 'What is the range?', theySpoke: true, editor: {} }),
    sendMessageInOpenThread: async (p, e, text) => { sent.push(text); return true; },
    closeThread: async () => {},
  };
  await runMessages(null, s, cfg, { ops, pause: false });
  assert.deepEqual(sent, ['Hi Fay, the range is on the brief.\nSending now.']);
  assert.equal(s.get('linkedin.com/in/f').queue.length, 0);
  // a queued message without resume still waits
  s.get('linkedin.com/in/f').queue.push({ text: 'Another one', resume: false }); s.save();
  sent.length = 0;
  await runMessages(null, s, cfg, { ops, pause: false });
  assert.deepEqual(sent, []);
});

test('invites: weekly ceiling across all roles; InMail credits: 30 a month, replies give them back', async () => {
  const { remaining, inmailCredits } = await import('../src/limits.js');
  const s = fresh();
  const past = d => new Date(Date.now() - d * 86400e3).toISOString();
  for (let i = 0; i < 78; i++) s.data.actions.push({ type: 'connects', url: `x${i}`, at: past(2) });
  assert.equal(remaining(s, { connects: 15, weeklyConnects: 80 }, 'connects'), 2, 'weekly ceiling wins over the daily cap');
  for (let i = 0; i < 5; i++) s.data.actions.push({ type: 'connects', url: `y${i}`, at: past(9) });
  assert.equal(remaining(s, { connects: 15, weeklyConnects: 80 }, 'connects'), 2, 'older than 7 days does not count');
  const now = new Date();
  for (let i = 0; i < 29; i++) s.data.actions.push({ type: 'inmail', url: `z${i}`, at: now.toISOString() });
  s.data.actions.push({ type: 'inmailRefund', url: 'z1', at: now.toISOString() });
  assert.deepEqual(inmailCredits(s, 30, now, 'Asia/Dubai'), { total: 30, used: 28, left: 2 });
});

test('audit: templates never go to someone in an InMail conversation; old queued text never goes after they wrote', async () => {
  const cand = { ...cfg, mode: 'candidates', followUps: [{ afterHours: 0, text: 'hi' }] };
  const lead = { status: 'accepted', queue: [], messages: [], acceptedAt: '2026-09-20T00:00:00Z', inmail: { sentAt: '2026-09-19T00:00:00Z' } };
  assert.equal(dueMessage(lead, cand, new Date('2026-09-22T00:00:00Z')), null);
  const s = fresh();
  const a = s.upsertLead({ url: 'linkedin.com/in/q', name: 'Q Q', campaign: 'c1' });
  s.setStatus(a.url, 'accepted', { acceptedAt: '2026-09-20T00:00:00Z' });
  a.queue.push({ text: 'old note' }); s.save();
  const sent = [];
  const ops = { readOwnName: async () => 'Kai Crayford', closeThread: async () => {},
    openThread: async () => ({ opened: true, lastFrom: 'me', theySpoke: true, editor: {} }),
    sendMessageInOpenThread: async (p, e, text) => { sent.push(text); return true; } };
  await runMessages(null, s, cfg, { ops, pause: false });
  assert.deepEqual(sent, []);
  assert.equal(s.get(a.url).status, 'replied');
});

test('1st connections: free message, one follow-up, Recruiter find looked up first, old chat skipped', async () => {
  const fcfg = { ...cfg, workingHours: null, firstDegree: { message: 'Hi {firstName}, about {role}', followUpAfterDays: 4, followUp: 'Bump {firstName}' }, role: { title: 'Cloud Engineer' } };
  const lead = { status: 'accepted', queue: [], messages: [], firstName: 'Ann', direct: { at: '2026-09-20T00:00:00Z' }, preexisting: true };
  assert.equal(dueMessage(lead, fcfg, new Date('2026-09-20T01:00:00Z')).text, 'Hi Ann, about Cloud Engineer');
  lead.messages.push({ lane: 'direct', at: '2026-09-20T01:00:00Z', text: 'x' });
  assert.equal(dueMessage(lead, fcfg, new Date('2026-09-22T01:00:00Z')), null);
  assert.equal(dueMessage(lead, fcfg, new Date('2026-09-24T02:00:00Z')).text, 'Bump Ann');
  lead.messages.push({ lane: 'direct', at: '2026-09-24T02:00:00Z', text: 'y' });
  assert.equal(dueMessage(lead, fcfg, new Date('2026-10-30T00:00:00Z')), null);

  const s = fresh();
  const a = s.upsertLead({ url: 'https://www.linkedin.com/talent/profile/AAA1', name: 'Rec One', campaign: 'c1', degree: '1st' });
  const b = s.upsertLead({ url: 'linkedin.com/in/oldchat', name: 'Old Chat', campaign: 'c1', degree: '1st' });
  for (const l of [a, b]) s.setStatus(l.url, 'accepted', { preexisting: true, acceptedAt: '2026-09-20T00:00:00Z', direct: { at: '2026-09-20T00:00:00Z' } });
  s.save();
  const sent = [];
  const ops = { readOwnName: async () => 'Kai Crayford', closeThread: async () => {},
    publicUrlFor: async () => 'https://www.linkedin.com/in/rec-one/',
    openThread: async (p, url) => url.includes('oldchat') ? { opened: true, lastFrom: 'them', theySpoke: true, editor: {} } : { opened: true, lastFrom: 'me', theySpoke: true, editor: {} },
    sendMessageInOpenThread: async (p, e, text) => { sent.push(text); return true; } };
  await runMessages(null, s, fcfg, { ops, pause: false });
  assert.deepEqual(sent, ['Hi Rec, about Cloud Engineer']);            // earlier words in an old chat do not block it
  assert.equal(s.get('linkedin.com/in/rec-one').status, 'messaged');
  assert.equal(s.get('linkedin.com/in/rec-one').messages[0].lane, 'direct');
  assert.equal(s.get('linkedin.com/in/oldchat').status, 'skipped');
});

test('connect never invites a 1st connection', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/first', campaign: 'c1', approved: true, degree: '1st' });
  s.save();
  let calls = 0;
  const ops = { sendConnectionRequest: async () => { calls++; return { result: 'sent', info: {} }; } };
  await runConnect(null, s, { ...cfg, workingHours: null }, { ops, pause: false });
  assert.equal(calls, 0);
});

test('names: every message says the real first name, and nothing goes without one', async () => {
  const { render, renderChecked, unknownTags, nameFor } = await import('../src/template.js');
  const role = { title: 'Senior Cloud Security Engineer', location: 'New York', workType: 'hybrid' };
  const kai = "Hey {firstName}, just wondering if you're on the market at the moment, as I have a new role, {role}, you might like. Let me know. Kai";
  for (const [name, first] of [['Jordan Reyes', 'Jordan'], ['JORDAN REYES', 'Jordan'], ['priya nair', 'Priya'], ['Dr. Jane Doe, CISSP', 'Jane'], ['Anne-Marie Lopez', 'Anne-Marie'], ['José Álvarez', 'José']]) {
    const lead = { name, firstName: (await import('../src/store.js')).firstNameOf(name) };
    const { text, problem } = renderChecked(kai, lead, role);
    assert.equal(problem, '', name);
    assert.ok(text.startsWith(`Hey ${first}, just`), `${name} -> ${text}`);
    assert.doesNotMatch(text, /[{}\[\]]/);
  }
  // every spelling Kai might type
  for (const tag of ['{firstName}', '{firstname}', '{FirstName}', '{name}', '[firstname]']) assert.equal(render(`Hi ${tag}`, { firstName: 'Sam' }), 'Hi Sam');
  assert.match(renderChecked('Hi {firstName}, {role name}', { firstName: 'Sam' }, role).problem, /unknown tag/);   // a misspelt tag is held back...
  assert.deepEqual(unknownTags('Role: {role name} {fristName}'), ['{role name}', '{fristName}']);   // ...so saving refuses it
  // no name, or only an initial: held back, never "Hey ,"
  for (const lead of [{}, { firstName: '' }, { firstName: 'J' }, { firstName: 'J.' }]) assert.match(renderChecked(kai, lead, role).problem, /first name/);
  assert.equal(nameFor({ firstName: 'MCDONALD' }), 'Mcdonald');
  // the runner holds back a connection note and a message with no name
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/noname', name: '', campaign: 'c1', approved: true });
  const m = s.upsertLead({ url: 'linkedin.com/in/noname2', name: '', campaign: 'c1' });
  s.setStatus(m.url, 'accepted', { acceptedAt: '2026-09-20T00:00:00Z', direct: { at: '2026-09-20T00:00:00Z' }, preexisting: true });
  s.save();
  let calls = 0;
  const fcfg = { ...cfg, workingHours: null, firstDegree: { message: 'Hi {firstName}', followUpAfterDays: 4, followUp: 'x' } };
  await runConnect(null, s, fcfg, { ops: { sendConnectionRequest: async () => { calls++; return { result: 'sent', info: {} }; } }, pause: false });
  await runMessages(null, s, fcfg, { ops: { readOwnName: async () => 'Kai Crayford', openThread: async () => { calls++; return { opened: false }; }, closeThread: async () => {} }, pause: false });
  assert.equal(calls, 0);
  assert.match(s.get('linkedin.com/in/noname').error, /first name/);
  assert.match(s.get('linkedin.com/in/noname2').error, /first name/);
});

test('self-healing: a failed invite is tried again, 3 in a row pause invites and say why', async () => {
  const s = fresh();
  for (const n of ['fa', 'fb', 'fc', 'fd']) s.upsertLead({ url: `linkedin.com/in/${n}`, name: `${n.toUpperCase()} Person`, campaign: 'c1', approved: true });
  s.save();
  let calls = 0;
  const ops = { sendConnectionRequest: async () => { calls++; return { result: 'failed', info: {} }; } };
  await runConnect(null, s, { ...cfg, dailyCaps: { connects: 10, messages: 2, profileViews: 50 } }, { ops, pause: false });
  assert.equal(calls, 3);                                        // stopped after 3 in a row
  assert.match(s.data.meta.health.connect.problem, /paused/);      // invites only, not the whole day
  assert.equal(s.get('linkedin.com/in/fa').status, 'new');       // not an error yet: tried again next pass
  assert.equal(s.get('linkedin.com/in/fa').attempts, 1);
  // two more passes: the third failure for the same person makes it a problem Kai sees.
  // (the pause only holds for an hour, so the test clears it to stand in for time passing)
  delete s.data.meta.health; s.save();
  await runConnect(null, s, { ...cfg, dailyCaps: { connects: 10, messages: 2, profileViews: 50 } }, { ops, pause: false });
  delete s.data.meta.health; s.save();
  await runConnect(null, s, { ...cfg, dailyCaps: { connects: 10, messages: 2, profileViews: 50 } }, { ops, pause: false });
  assert.equal(s.get('linkedin.com/in/fa').status, 'error');
  // a success clears the pause
  const ok = { sendConnectionRequest: async () => ({ result: 'sent', info: {} }) };
  s.setStatus('linkedin.com/in/fa', 'new'); delete s.data.meta.health; s.save();
  await runConnect(null, s, { ...cfg, dailyCaps: { connects: 10, messages: 2, profileViews: 50 } }, { ops: ok, pause: false });
  assert.deepEqual(s.data.meta.health, {});
  assert.deepEqual(new Store(s.file).data.meta.health, {});      // and the removal reached the file
});

test('invites record which note went, for the learning loop', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/nx', name: 'Nora Ex', campaign: 'c1', approved: true });
  s.save();
  await runConnect(null, s, { ...cfg, connectionNotes: ['Hi {firstName} one', 'Hi {firstName} two'] }, { ops: { sendConnectionRequest: async () => ({ result: 'sent', noteSent: true, info: {} }) }, pause: false });
  const a = s.data.actions.find(x => x.type === 'connects');
  assert.equal(a.campaign, 'c1');
  assert.ok(['Hi {firstName} one', 'Hi {firstName} two'].includes(a.noteTemplate));
});

test('audit 2: no template after a reply; failed tries still count as views; the right queued message is removed', async () => {
  const fcfg = { ...cfg, firstDegree: { message: 'Hi {firstName}', followUpAfterDays: 4, followUp: 'Bump {firstName}' } };
  const lead = { status: 'messaged', queue: [], firstName: 'Ann', direct: { at: '2026-09-20T00:00:00Z' }, repliedAt: '2026-09-21T00:00:00Z',
    messages: [{ lane: 'direct', at: '2026-09-20T01:00:00Z', text: 'Hi Ann' }, { at: '2026-09-21T02:00:00Z', text: 'Great, sending the brief' }] };
  assert.equal(dueMessage(lead, fcfg, new Date('2026-09-30T00:00:00Z')), null);

  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/v1', name: 'Vee One', campaign: 'c1', approved: true });
  s.save();
  await runConnect(null, s, cfg, { ops: { sendConnectionRequest: async () => ({ result: 'failed', info: {} }) }, pause: false });
  assert.equal(s.actionsSince('2000-01-01', 'profileViews').length, 1);
  assert.equal(new Store(s.file).actionsSince('2000-01-01', 'profileViews').length, 1);

  const q = s.upsertLead({ url: 'linkedin.com/in/q2', name: 'Quinn Two', campaign: 'c1' });
  s.setStatus(q.url, 'accepted', { acceptedAt: '2026-09-20T00:00:00Z' });
  q.queue.push({ text: 'A' }, { text: 'B' });
  s.save();
  const ops = { readOwnName: async () => 'Kai Crayford', closeThread: async () => {},
    openThread: async () => ({ opened: true, lastFrom: 'me', theySpoke: false, editor: {} }),
    // while A is being typed, Kai removes A in the app
    sendMessageInOpenThread: async () => { const o = new Store(s.file); o.get('linkedin.com/in/q2').queue.shift(); o.save(); return true; } };
  await runMessages(null, s, cfg, { ops, pause: false, max: 1 });
  assert.deepEqual(new Store(s.file).get('linkedin.com/in/q2').queue.map(x => x.text), ['B']);
});

test('a stop request cuts a wait short', async () => {
  const { pauseFor } = await import('../src/limits.js');
  const { stopFlag } = await import('../src/stop.js');
  stopFlag.on = true;
  const t = Date.now(); await pauseFor(5000);
  assert.ok(Date.now() - t < 1500);
  stopFlag.on = false;
});

test('InMail lane: rehearses first, then sends, stays inside the credits and never touches a client', async () => {
  const { runInMails, creditsFromText } = await import('../src/actions/inmail.js');
  assert.deepEqual(creditsFromText('Preview | 1/84 InMail Credits'), { cost: 1, left: 84 });
  const s = fresh();
  const icfg = { ...cfg, inmail: { afterDays: 7, subject: '{role} in {location}', body: 'Hi {firstName}, about the {role} role.', monthlyCredits: 30, perDay: 2, viaRecruiter: true }, role: { title: 'Cloud Engineer', location: 'New York' } };
  for (const n of ['Ana', 'Ben', 'Cara']) {
    const lead = s.upsertLead({ url: `https://www.linkedin.com/talent/profile/AAA${n}`, name: `${n} Smith`, headline: 'Security Engineer', campaign: 'c1', approved: true, degree: '2nd' });
    s.setStatus(lead.url, 'invited', { invitedAt: new Date(Date.now() - 8 * 86400e3).toISOString() });
  }
  const freshInvite = s.upsertLead({ url: 'https://www.linkedin.com/talent/profile/FRESH', name: 'Fresh Invite', campaign: 'c1', approved: true, degree: '2nd' });
  s.setStatus(freshInvite.url, 'invited', { invitedAt: new Date().toISOString() });
  s.upsertLead({ url: 'https://www.linkedin.com/talent/profile/NEVER', name: 'Never Invited', campaign: 'c1', approved: true, degree: '2nd' });
  s.upsertLead({ url: 'https://www.linkedin.com/talent/profile/FIRST', name: 'Al Ready', campaign: 'c1', approved: true, degree: '1st' });
  s.save();
  const calls = [];
  const ops = { sendRecruiterInMail: async (p, url, o) => { calls.push({ url, ...o }); return o.rehearse ? { sent: false, rehearsed: true, credits: { cost: 1, left: 84 }, shot: '/x/shot.png' } : { sent: true, credits: { cost: 1, left: 83 } }; } };

  let r = await runInMails(null, s, icfg, { ops, pause: false });
  assert.equal(r.rehearsed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].subject, 'Cloud Engineer in New York');
  assert.equal(s.data.meta.inmailRehearsal.shot, 'shot.png');
  assert.equal(s.data.meta.inmailBalance, 84);

  s.data.meta.inmailApprovedAt = new Date().toISOString(); s.save();
  r = await runInMails(null, s, icfg, { ops, pause: false });
  assert.equal(r.sent, 2, 'the daily limit of 2 holds');
  assert.equal(s.leads({ campaign: 'c1', status: 'messaged' }).length, 2);
  const one = s.leads({ campaign: 'c1', status: 'messaged' })[0];
  assert.equal(one.channel, 'inmail');
  assert.ok(one.inmail.sentAt);
  assert.equal(s.actionsSince('2000-01-01', 'inmail').length, 2);
  assert.equal(s.get('https://www.linkedin.com/talent/profile/FIRST').status, 'new');   // 1st connections are free elsewhere
  assert.ok(!calls.some(c => c.url.includes('FIRST')));
  assert.ok(!calls.some(c => c.url.includes('FRESH')));
  assert.ok(!calls.some(c => c.url.includes('NEVER')));
  assert.match(calls[1].body, /^Hi (Ana|Ben|Cara), about the Cloud Engineer role\.$/);
});

test('a search asked for mid-run is picked up once, for the right role', async () => {
  const { askFor, pending, takeRequests } = await import('../src/requests.js');
  askFor('role-one', 'search');
  askFor('role-one', 'search');            // pressing twice is still one search
  askFor('role-two', 'search');
  assert.deepEqual(pending('role-one'), ['search']);
  assert.deepEqual(takeRequests('role-one'), ['search']);
  assert.deepEqual(takeRequests('role-one'), []);
  assert.deepEqual(pending('role-two'), ['search']);
  assert.equal(fs.statSync(path.join(home, 'requests.json')).mode & 0o777, 0o600);
});

// ---- 24 Sep: what Kai found using it for real ----

test('an InMailed candidate is never closed as "no longer a 1st degree connection"', async () => {
  const s = fresh();
  // reached by InMail in Recruiter: 2nd degree, which is exactly why they got an InMail
  const l = s.upsertLead({ url: 'linkedin.com/in/im1', name: 'Im One', campaign: 'c1', degree: '2nd' });
  s.setStatus(l.url, 'messaged', { channel: 'inmail' });
  l.inmail = { sentAt: new Date(Date.now() - 3 * 86400e3).toISOString() };
  s.save();
  let opened = 0;
  const ops = { readOwnName: async () => 'Kai Crayford', closeThread: async () => {},
    openThread: async () => { opened++; return { opened: false, reason: 'not-connected' }; } };
  await sweepReplies(null, s, cfg, { ops, pause: false });
  assert.equal(opened, 0, 'their reply arrives in Recruiter, so there is no thread to open');
  assert.equal(s.get(l.url).status, 'messaged', 'and they stay in the outreach list');
  assert.ok(!/1st degree/.test(s.get(l.url).error || ''));
});

test('only somebody who really was connected is closed when LinkedIn says not connected', async () => {
  const s = fresh();
  const was = s.upsertLead({ url: 'linkedin.com/in/w1', name: 'Was Connected', campaign: 'c1', degree: '1st' });
  s.setStatus(was.url, 'messaged', { preexisting: true, direct: { at: '2026-09-20T00:00:00Z' }, acceptedAt: '2026-09-20T00:00:00Z' });
  was.messages.push({ lane: 'direct', at: '2026-09-20T01:00:00Z', text: 'x' });
  const never = s.upsertLead({ url: 'linkedin.com/in/n1', name: 'Never Connected', campaign: 'c1', degree: '3rd' });
  s.setStatus(never.url, 'messaged');
  never.messages.push({ at: '2026-09-20T01:00:00Z', text: 'x' });
  s.save();
  const ops = { readOwnName: async () => 'Kai Crayford', closeThread: async () => {},
    openThread: async () => ({ opened: false, reason: 'not-connected' }) };
  await sweepReplies(null, s, cfg, { ops, pause: false });
  assert.equal(s.get(was.url).status, 'skipped', 'a real connection that has gone is closed');
  assert.equal(s.get(never.url).status, 'messaged', 'somebody who was never connected is left alone');
});

test('deleting a role keeps everyone it actually contacted', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/keep1', name: 'Invited', campaign: 'c1', approved: true });
  s.setStatus('linkedin.com/in/keep1', 'invited', { invitedAt: new Date().toISOString() });
  const k2 = s.upsertLead({ url: 'linkedin.com/in/keep2', name: 'InMailed', campaign: 'c1' });
  k2.inmail = { sentAt: new Date().toISOString() };
  s.upsertLead({ url: 'linkedin.com/in/drop1', name: 'Never Touched', campaign: 'c1', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/other', name: 'Other Role', campaign: 'c2', approved: true });
  s.save();

  const dry = s.deleteCampaign('c1', { dryRun: true });
  assert.deepEqual(dry, { removed: 1, kept: 2 });
  assert.ok(s.get('linkedin.com/in/drop1'), 'a dry run changes nothing');

  assert.deepEqual(s.deleteCampaign('c1'), { removed: 1, kept: 2 });
  assert.equal(s.get('linkedin.com/in/drop1'), undefined, 'nobody untouched is kept');
  assert.ok(s.get('linkedin.com/in/keep1'), 'the person you invited stays on file');
  assert.ok(s.get('linkedin.com/in/keep2'), 'and so does the one you InMailed');
  assert.equal(s.get('linkedin.com/in/keep1').approved, false, 'but nothing more goes to them');
  assert.ok(s.get('linkedin.com/in/keep1').roleDeletedAt);
  assert.ok(s.get('linkedin.com/in/other'), 'another role is untouched');
  // and that is what stops a later search approaching them twice
  s.save();
  assert.ok(new Store(s.file).get('linkedin.com/in/keep1'), 'it reached the file');
});

test('the outreach list puts answers first and never invents contact', async () => {
  const { outreachList } = await import('../src/app.js');
  const s = fresh();
  const icfg = { ...cfg, inmail: { followUpAfterDays: 4 } };
  const quiet = s.upsertLead({ url: 'linkedin.com/in/o1', name: 'Quiet One', campaign: 'c1' });
  quiet.inmail = { sentAt: new Date(Date.now() - 1 * 86400e3).toISOString() };
  s.setStatus(quiet.url, 'messaged', { channel: 'inmail' });
  const answered = s.upsertLead({ url: 'linkedin.com/in/o2', name: 'Answered Two', campaign: 'c1' });
  answered.inmail = { sentAt: new Date(Date.now() - 5 * 86400e3).toISOString(), replied: new Date().toISOString() };
  s.setStatus(answered.url, 'replied', { repliedAt: new Date().toISOString(), lastReply: 'Yes, tell me more' });
  s.upsertLead({ url: 'linkedin.com/in/o3', name: 'Not Contacted', campaign: 'c1', approved: true });
  s.save();

  const out = outreachList(s, { ...icfg, name: 'c1' });
  assert.equal(out.length, 2, 'somebody never contacted is not outreach');
  assert.equal(out[0].name, 'Answered Two', 'the answer is at the top');
  assert.equal(out[0].replied, true);
  assert.equal(out[0].lastReply, 'Yes, tell me more');
  assert.equal(out[0].awaitingInmail, false, 'you are not asked whether somebody who answered replied');
  assert.equal(out[1].name, 'Quiet One');
  assert.equal(out[1].how, 'InMail');
  assert.equal(out[1].awaitingInmail, true, 'the quiet one can be marked as replied by hand');
  assert.equal(out[1].followUpDue, false, 'one day is not four');
  assert.equal(out[0].reached, true);
  assert.equal(out[1].reached, true);
});

test('somebody only lined up is never described as contacted', async () => {
  const { outreachList } = await import('../src/app.js');
  const s = fresh();
  // queued for the 1st-connections message: nothing has gone to them yet
  const q = s.upsertLead({ url: 'linkedin.com/in/lined', name: 'Lined Up', campaign: 'c1', degree: '1st' });
  s.setStatus(q.url, 'accepted', { preexisting: true, acceptedAt: new Date().toISOString(), direct: { at: new Date().toISOString() } });
  const done = s.upsertLead({ url: 'linkedin.com/in/done', name: 'Really Sent', campaign: 'c1' });
  done.inmail = { sentAt: new Date(Date.now() - 86400e3).toISOString() };
  s.setStatus(done.url, 'messaged', { channel: 'inmail' });
  s.save();
  const out = outreachList(s, { ...cfg, name: 'c1' });
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Really Sent', 'what actually went ranks above what is only queued');
  assert.equal(out[0].reached, true);
  assert.equal(out[1].name, 'Lined Up');
  assert.equal(out[1].reached, false, 'nothing has gone to them, so the screen must not say sent');
});

test('experience is never the sum of overlapping roles', async () => {
  const { experienceMonths } = await import('../src/company.js');
  // Recruiter now gives years, not months, so every role rounds up and they overlap.
  const history = [
    { term: 'Principal Engineer', duration: '2024 – Present' },
    { term: 'Staff Engineer', duration: '2022 – 2024' },
    { term: 'Consultant', duration: '2022 – 2023' },
    { term: 'Engineer', duration: '2019 – 2022' },
    { term: 'Engineer', duration: '2016 – 2019' },
  ];
  const m = experienceMonths(history, new Date('2026-09-24T00:00:00Z'));
  // 2016 to now is about ten years. Adding the roles up would say seventeen.
  assert.ok(m >= 110 && m <= 132, `expected about ten years, got ${m} months`);
});

test('anybody excluded by hand is never put back by a later search', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/x1', name: 'Ex One', headline: 'old headline', campaign: 'c1', approved: true });
  s.upsertLead({ url: 'linkedin.com/in/auto', name: 'Auto Skip', campaign: 'c1' });
  s.upsertLead({ url: 'linkedin.com/in/fresh', name: 'Fresh One', campaign: 'c1' });
  s.setStatus('linkedin.com/in/x1', 'skipped', { error: 'excluded by hand', skippedByHand: true });
  s.setStatus('linkedin.com/in/auto', 'skipped', { error: 'no Connect button on profile' });
  s.save();

  // Clear list used to delete the hand-excluded, which is the same as un-excluding them
  assert.equal(s.clearUncontacted('c1'), 2, 'the untouched and the automatically skipped go');
  assert.ok(s.get('linkedin.com/in/x1'), 'the one you excluded stays on file');
  assert.equal(s.get('linkedin.com/in/auto'), undefined);
  assert.equal(s.get('linkedin.com/in/fresh'), undefined);

  // a later search finds them again: the exclusion holds, and nothing re-approves them
  s.upsertLead({ url: 'linkedin.com/in/x1', name: 'Ex One', headline: 'new headline', campaign: 'c1', approved: true });
  assert.equal(s.get('linkedin.com/in/x1').status, 'skipped');
  assert.equal(s.get('linkedin.com/in/x1').skippedByHand, true);
  assert.ok(!s.leads({ campaign: 'c1', status: 'new' }).some(l => l.url.includes('/x1')));

  // and deleting the whole role does not un-exclude them either
  assert.equal(s.deleteCampaign('c1').kept, 1);
  assert.ok(s.get('linkedin.com/in/x1'), 'still on file after the role is gone');
});
