import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const { Store } = await import('../src/store.js');
const H = await import('../src/heal.js');
const { runConnect } = await import('../src/actions/connect.js');

const cfg = {
  name: 'c1', mode: 'candidates', autoApprove: false, noteMaxLength: 300,
  connectionNotes: ['Hey {firstName}, would be great to connect.'],
  followUps: [], dailyCaps: { connects: 10, messages: 5, profileViews: 40 },
  workingHours: null, pauseBetweenActionsSec: [0, 0],
};
const fresh = () => { const s = new Store(path.join(home, `db-${Math.random()}.json`)); s.data.meta.ownName = 'Kai'; s.save(); return s; };

test('a name inside a label goes back to a placeholder, or it works once and never again', () => {
  assert.equal(H.templatise('Invite Ada Lovelace to connect', 'Ada Lovelace'), 'Invite {name} to connect');
  assert.equal(H.templatise('Message Ada', 'Ada Lovelace'), 'Message {firstName}',
    'the first name gets its own placeholder, or it would be refilled with the full name and match nobody');
  // whole words only: a common first name must not eat an unrelated label
  assert.equal(H.templatise('Grace period reminder', 'Tom Other'), 'Grace period reminder');
  assert.equal(H.templatise('Send now', 'Ada Lovelace'), 'Send now');
  assert.equal(H.templatise('Send now', ''), 'Send now');
});

test('a choice becomes several ways to find it, their own test attributes first', () => {
  const sel = H.selectorsFor({ tag: 'button', name: 'Send now', text: 'Send now', label: 'Send now', data: { 'data-test-send-invite': 'true' }, id: 'custom-1' });
  assert.equal(sel[0], '[data-test-send-invite="true"]', 'their own attribute is the most stable thing on the page');
  assert.ok(sel.includes('button[aria-label="Send now"]'));
  assert.ok(sel.includes('button:text-is("Send now")'), 'exact text, never a substring');
  assert.ok(!sel.some(x => /has-text/.test(x)), ':has-text would also match "Send message" elsewhere on the page');
});

test('generated ids are never learned, whichever side spots them', () => {
  for (const bad of ['ember123', 'ember1043', ':r7:', 'react-aria-9182', 'x1234567']) {
    assert.equal(H.stableId(bad), false, bad);
    assert.ok(!H.selectorsFor({ tag: 'button', name: 'Send', data: {}, id: bad }).some(x => x.startsWith('#')), bad);
  }
  assert.equal(H.stableId('custom-message'), true);
});

test('a label carrying the name is not also learned as fixed text', () => {
  const sel = H.selectorsFor({ tag: 'button', name: 'Invite Ada Lovelace to connect', label: 'Invite Ada Lovelace to connect', text: '', data: {} }, { name: 'Ada Lovelace' });
  assert.deepEqual(sel, ['button[aria-label="Invite {name} to connect"]']);
  assert.ok(!sel.some(x => /has-text/.test(x)), 'a has-text selector with a placeholder in it would never match');
});

test('the likely one is offered first, and cancel is pushed down', () => {
  const order = H.orderCandidates([
    { n: 1, name: 'Cancel', tag: 'button' },
    { n: 2, name: '', tag: 'textarea', typable: true },
    { n: 3, name: 'Send now', tag: 'button', primary: true },
  ], { want: 'send' });
  assert.equal(order[0].name, 'Send now');
  assert.equal(order[order.length - 1].name, 'Cancel');
});

test('learned ways are tried before the ones we shipped with, with the name filled in', () => {
  const s = fresh();
  H.askFor(s, { step: 'sendInviteButton', lane: 'connect', why: 'gone', lead: { name: 'Ada Lovelace' },
    candidates: [{ n: 1, tag: 'button', name: 'Invite Ada Lovelace to connect', label: 'Invite Ada Lovelace to connect', text: '', data: {} }] });
  assert.equal(H.answer(s, 1).ok, true);
  const list = H.candidatesFor(s, 'sendInviteButton', ['button[shipped]'], { name: 'Ada Lovelace' });
  assert.equal(list[0], 'button[aria-label="Invite Ada Lovelace to connect"]');
  assert.equal(list[1], 'button[shipped]', 'what we shipped with is still there as a fallback');
  assert.equal(H.pendingQuestion(s), null, 'the question is cleared once answered');
});

test('a bad answer changes nothing', () => {
  const s = fresh();
  assert.equal(H.answer(s, 1).ok, false, 'nothing is waiting');
  H.askFor(s, { step: 'x', lane: 'connect', why: 'gone', candidates: [{ n: 1, tag: 'button', name: 'A', text: 'A', label: '', data: {} }] });
  assert.equal(H.answer(s, 99).ok, false, 'not one of the choices');
  assert.ok(H.pendingQuestion(s), 'and the question is still there to answer properly');
  assert.equal(H.answer(s, 'none').skipped, true);
  assert.equal(H.pendingQuestion(s), null);
  assert.equal(H.learnedFor(s, 'x'), null, 'skipping learns nothing');
});

test('nothing learned is trusted until LinkedIn confirms an action that used it', () => {
  const s = fresh();
  H.askFor(s, { step: 'sendInviteButton', lane: 'connect', inDialog: true, why: 'gone', candidates: [{ n: 1, tag: 'button', name: 'Send', text: 'Send', label: '', data: {} }] });
  H.answer(s, 1);
  assert.equal(H.learnedFor(s, 'sendInviteButton').verified, false);
  assert.equal(H.unproven(s, 'connect').length, 1);
  H.confirmSteps(s, ['sendInviteButton']);
  assert.equal(H.learnedFor(s, 'sendInviteButton').verified, true);
  assert.equal(H.unproven(s, 'connect').length, 0);
  // and a confirmed one is not thrown away by a later bad patch
  H.discardLane(s, 'connect');
  assert.ok(H.learnedFor(s, 'sendInviteButton'), 'a proven control survives');
});

test('one lane being down leaves the others alone', () => {
  const s = fresh();
  H.laneDown(s, 'connect', 'cannot find the send button');
  assert.equal(H.laneIsDown(s, 'connect'), true);
  assert.equal(H.laneIsDown(s, 'inmail'), false);
  assert.equal(H.laneIsDown(s, 'messages'), false);
  H.laneUp(s, 'connect');
  assert.equal(H.laneIsDown(s, 'connect'), false);
  // an old problem has expired
  H.laneDown(s, 'connect', 'x');
  s.data.meta.health.connect.at = new Date(Date.now() - 2 * 3600e3).toISOString();
  assert.equal(H.laneIsDown(s, 'connect'), false);
});

test('while a question is waiting, invites stop and nothing is counted as failed', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/q1', name: 'Q One', campaign: 'c1', approved: true });
  s.save();
  H.askFor(s, { step: 'sendInviteButton', lane: 'connect', why: 'gone', candidates: [] });
  s.save();
  let called = 0;
  const r = await runConnect(null, s, cfg, { ops: { sendConnectionRequest: async () => { called++; return { result: 'sent', info: {} }; } }, pause: false });
  assert.equal(called, 0, 'it does not keep trying a step it knows is broken');
  assert.equal(r.needsYou, true);
  assert.equal(s.get('linkedin.com/in/q1').status, 'new', 'and nobody is marked failed for it');
});

test('a step that cannot be found stops that lane and asks, instead of burning attempts', async () => {
  const s = fresh();
  for (const n of ['a', 'b', 'c']) s.upsertLead({ url: `linkedin.com/in/n${n}`, name: `N${n.toUpperCase()} Person`, campaign: 'c1', approved: true });
  s.save();
  let called = 0;
  const r = await runConnect(null, s, cfg, {
    ops: { sendConnectionRequest: async () => { called++; return { result: 'needs-you', info: { name: 'NA Person' } }; } },
    pause: false,
  });
  assert.equal(called, 1, 'it asks once rather than working through the whole list');
  assert.equal(r.needsYou, true);
  assert.equal(s.get('linkedin.com/in/na').attempts, undefined, 'a changed page is not that person’s fault');
  assert.equal(s.get('linkedin.com/in/na').status, 'new');
});

test('three real failures pause invites only, and forget an unproven control', async () => {
  const s = fresh();
  for (const n of ['a', 'b', 'c', 'd']) s.upsertLead({ url: `linkedin.com/in/f${n}`, name: `F${n.toUpperCase()} Person`, campaign: 'c1', approved: true });
  H.askFor(s, { step: 'sendInviteButton', lane: 'connect', inDialog: true, why: 'gone', candidates: [{ n: 1, tag: 'button', name: 'Wrong one', text: 'Wrong one', label: '', data: {} }] });
  H.answer(s, 1);
  s.save();
  await runConnect(null, s, cfg, { ops: { sendConnectionRequest: async () => ({ result: 'failed', info: {} }) }, pause: false });
  assert.match(s.data.meta.health.connect.problem, /paused/);
  assert.equal(s.data.meta.health.inmail, undefined, 'InMail is untouched');
  assert.equal(H.learnedFor(s, 'sendInviteButton'), null, 'the wrong choice is forgotten rather than repeated');
});

test('a confirmed invite proves what was learned and clears the pause', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/ok1', name: 'Ok One', campaign: 'c1', approved: true });
  H.askFor(s, { step: 'sendInviteButton', lane: 'connect', inDialog: true, why: 'gone', candidates: [{ n: 1, tag: 'button', name: 'Send now', text: 'Send now', label: '', data: {} }] });
  H.answer(s, 1);
  H.laneDown(s, 'connect', 'was down');
  s.save();
  // the pause would normally hold for an hour; stand in for time passing
  s.data.meta.health.connect.at = new Date(Date.now() - 2 * 3600e3).toISOString();
  s.save();
  await runConnect(null, s, cfg, { ops: { sendConnectionRequest: async () => ({ result: 'sent', info: {}, usedSteps: ['sendInviteButton'] }) }, pause: false });
  assert.equal(H.learnedFor(s, 'sendInviteButton').verified, true);
  assert.equal(H.laneIsDown(s, 'connect'), false);
  assert.equal(new Store(s.file).data.meta.learned.sendInviteButton.verified, true, 'and it reached the file');
});

test('end to end in a browser: the button moves, Sourcer asks, learns, and sends', async () => {
  const { chromium } = await import('playwright');
  const exe = process.env.SOURCER_CHROME;
  const b = await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null);
  if (!b) return;   // no browser on this machine
  try {
    const { firstVisible } = await import('../src/selectors.js');
    const p = await b.newPage();
    // LinkedIn's redesigned invite window: none of the selectors we shipped with are here
    await p.setContent(`
      <div role="dialog">
        <h2>Add a note to your invitation</h2>
        <div contenteditable="true" data-control-name="invite_note" style="width:300px;height:60px;border:1px solid #ccc"></div>
        <button id="ember904" style="width:90px;height:32px">Cancel</button>
        <button data-control-name="invite_send_v3" class="artdeco-button--primary"
                aria-label="Send invitation to Ada Lovelace" style="width:120px;height:32px">Send now</button>
      </div>`);

    const s = fresh();
    const shipped = ['button[aria-label="Send invitation"]', 'button[aria-label="Send now"]'];
    // 1. it cannot find the button and asks, rather than failing silently
    const missing = (await H.findOrAsk(p, {
      page: p, store: s, step: 'sendInviteButton', lane: 'connect', shipped,
      name: 'Ada Lovelace', want: 'send', why: 'the send button moved', timeout: 300, firstVisible,
    })).el;
    assert.equal(missing, null);
    const q = H.pendingQuestion(s);
    assert.ok(q, 'a question is waiting');
    assert.equal(q.lane, 'connect');
    assert.ok(q.candidates.length >= 3, 'it read the whole window out');
    assert.equal(q.candidates[0].name, 'Send now', 'and offered the likely one first');
    assert.equal(q.candidates[q.candidates.length - 1].name, 'Cancel');
    assert.equal(H.laneIsDown(s, 'connect'), true);

    // 2. Kai picks it from the list, inside Sourcer
    const picked = q.candidates[0];
    const r = H.answer(s, picked.n);
    assert.equal(r.ok, true);
    assert.equal(r.selectors[0], '[data-control-name="invite_send_v3"]', 'their own attribute, not a generated id');
    assert.ok(!r.selectors.some(x => /ember/.test(x)));

    // 3. the same lookup now finds it on the real page, with no further help
    const hit = await H.findOrAsk(p, {
      page: p, store: s, step: 'sendInviteButton', lane: 'connect', shipped,
      name: 'Ada Lovelace', want: 'send', why: 'x', timeout: 1500, firstVisible,
    });
    const found = hit.el;
    assert.ok(found, 'the learned control is found');
    assert.equal(hit.viaLearned, true, 'and it was the learned one that found it, not a shipped one');
    assert.equal(await found.getAttribute('aria-label'), 'Send invitation to Ada Lovelace');
    assert.equal(H.pendingQuestion(s), null, 'and it does not ask again');

    // 4. the name in the label was stored as a placeholder, so the next person also works
    await p.setContent(`<div role="dialog"><button data-control-name="invite_send_v3"
      aria-label="Send invitation to Tom Other">Send now</button></div>`);
    const next = (await H.findOrAsk(p, {
      page: p, store: s, step: 'sendInviteButton', lane: 'connect', shipped,
      name: 'Tom Other', want: 'send', why: 'x', timeout: 1500, firstVisible,
    })).el;
    assert.ok(next, 'and it works for somebody else too');
  } finally { await b.close(); }
});

test('the list shows the words on the button, not the screen-reader label', async () => {
  const { chromium } = await import('playwright');
  const exe = process.env.SOURCER_CHROME;
  const b = await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null);
  if (!b) return;
  try {
    const p = await b.newPage();
    await p.setContent(`<div role="dialog">
      <button aria-label="Send invitation to Ada Lovelace" data-control-name="send_v3">Send now</button></div>`);
    const read = await p.evaluate(H.READ_CANDIDATES);
    const c = read.candidates[0];
    assert.equal(c.name, 'Send now', 'what Kai sees in the picture');
    assert.equal(c.label, 'Send invitation to Ada Lovelace');
    // and the label, with the name taken out, is still used to find it
    const sel = H.selectorsFor(c, { name: 'Ada Lovelace' });
    assert.equal(sel[0], '[data-control-name="send_v3"]');
    assert.ok(sel.includes('button[aria-label="Send invitation to {name}"]'));
    assert.ok(sel.includes('button:text-is("Send now")'));
  } finally { await b.close(); }
});

// ---- what the review on 24 Sep found. Two of these would have clicked the wrong control on a
// real person's profile, which is the worst thing this tool can do.

test('an exact label is never allowed to match something else on the page', async () => {
  const { chromium } = await import('playwright');
  const exe = process.env.SOURCER_CHROME;
  const b = await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null);
  if (!b) return;
  try {
    const { firstVisible } = await import('../src/selectors.js');
    const p = await b.newPage();
    // the profile behind the invite window has its own buttons saying similar things
    await p.setContent(`
      <main>
        <button aria-label="Message Jane Doe">Send message</button>
        <button aria-label="Resend invitation">Resend</button>
      </main>
      <div role="dialog"><button data-control-name="send_v9" aria-label="Send">Send</button></div>`);
    const s = fresh();
    await H.findOrAsk(p, { page: p, store: s, step: 'sendInviteButton', lane: 'connect',
      shipped: ['button[aria-label="Send invitation"]'], name: 'Jane Doe', want: 'send', why: 'x', timeout: 200, firstVisible });
    const q = H.pendingQuestion(s);
    const send = q.candidates.find(c => c.name === 'Send');
    assert.ok(send, 'the dialog button is offered');
    H.answer(s, send.n);
    const learned = H.learnedFor(s, 'sendInviteButton');
    assert.equal(learned.inDialog, true, 'it remembers the control came from the window, not the page');
    assert.ok(!learned.selectors.some(x => /has-text/.test(x)), 'a substring match would also hit "Send message"');

    // and the lookup now resolves to the dialog button, not the profile one behind it
    const found = await H.findOrAsk(p, { page: p, store: s, step: 'sendInviteButton', lane: 'connect',
      shipped: [], name: 'Jane Doe', want: 'send', why: 'x', timeout: 1500, firstVisible });
    assert.ok(found.el);
    assert.equal(await found.el.getAttribute('data-control-name'), 'send_v9');
  } finally { await b.close(); }
});

test('a crafted display name cannot choose which button gets clicked', async () => {
  const { chromium } = await import('playwright');
  const exe = process.env.SOURCER_CHROME;
  const b = await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null);
  if (!b) return;
  try {
    const { firstVisible } = await import('../src/selectors.js');
    const s = fresh();
    H.askFor(s, { step: 'sendInviteButton', lane: 'connect', why: 'x', lead: { name: 'Ada Lovelace' },
      candidates: [{ n: 1, tag: 'button', name: 'Invite Ada Lovelace to connect', label: 'Invite Ada Lovelace to connect', text: '', data: {} }] });
    H.answer(s, 1);
    // the next person's LinkedIn display name is hostile
    const hostile = 'Eve" ], button[aria-label="Report this profile"], [x="';
    const list = H.candidatesFor(s, 'sendInviteButton', [], { name: hostile });
    const p = await b.newPage();
    await p.setContent(`<button aria-label="Report this profile">Report</button>
      <button aria-label="Invite someone to connect">Invite</button>`);
    const hit = await firstVisible(p, list, 400);
    assert.equal(hit, null, 'a name must never be able to point the selector at another button');
  } finally { await b.close(); }
});

test('an attribute name that is really a selector is refused', () => {
  const sel = H.selectorsFor({ tag: 'button', text: 'Looks harmless', label: '', data: { 'data-test-a],button[aria-label': 'Report this profile' } });
  assert.ok(!sel.some(x => /Report this profile/.test(x)), sel.join(' | '));
  assert.deepEqual(sel, ['button:text-is("Looks harmless")']);
  // a normal one still works
  assert.equal(H.selectorsFor({ tag: 'button', text: 'x', label: '', data: { 'data-test-send': 'y' } })[0], '[data-test-send="y"]');
});

test('a name with a quote in it does not produce a broken selector', () => {
  H.askFor; // (keeps the import honest)
  const s = fresh();
  H.askFor(s, { step: 'sendInviteButton', lane: 'connect', why: 'x', lead: { name: 'Mike "Mick" Jones' },
    candidates: [{ n: 1, tag: 'button', name: 'Invite Mike "Mick" Jones to connect', label: 'Invite Mike "Mick" Jones to connect', text: '', data: {} }] });
    H.answer(s, 1);
  const [first] = H.candidatesFor(s, 'sendInviteButton', [], { name: 'Mike "Mick" Jones' });
  assert.match(first, /\\"Mick\\"/, 'the quotes are escaped rather than ending the selector early');
});

test('a step the send never went through is not confirmed by it', async () => {
  const s = fresh();
  s.upsertLead({ url: 'linkedin.com/in/cs1', name: 'Cs One', campaign: 'c1', approved: true });
  // Kai mis-picked when asked about the note box
  H.askFor(s, { step: 'noteTextarea', lane: 'connect', why: 'x', candidates: [{ n: 1, tag: 'button', name: 'Cancel', label: 'Cancel', text: 'Cancel', data: {} }] });
  H.answer(s, 1);
  s.save();
  // a send that carried no note
  await runConnect(null, s, { ...cfg, connectionNotes: [] }, {
    ops: { sendConnectionRequest: async () => ({ result: 'sent', info: {}, usedSteps: [] }) }, pause: false,
  });
  assert.equal(H.learnedFor(s, 'noteTextarea').verified, false, 'it proved nothing about the note box');
  assert.equal(H.unproven(s, 'connect').length, 1, 'so three failures can still forget it');
});

test('a second question does not wipe out the first', () => {
  const s = fresh();
  H.askFor(s, { step: 'noteTextarea', lane: 'connect', why: 'first', candidates: [{ n: 1, tag: 'div', name: 'x', data: {} }] });
  H.askFor(s, { step: 'sendInviteButton', lane: 'connect', why: 'second', candidates: [{ n: 1, tag: 'button', name: 'y', data: {} }] });
  assert.equal(H.pendingQuestion(s).step, 'noteTextarea', 'the one Kai has not answered yet stays');
});

test('what Kai typed is never read off the page, pictured, or stored', async () => {
  const { chromium } = await import('playwright');
  const exe = process.env.SOURCER_CHROME;
  const b = await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null);
  if (!b) return;
  try {
    const p = await b.newPage();
    const secret = 'Hey Ada, about the Senior Cloud Security Engineer role';
    await p.setContent(`<div role="dialog">
      <div contenteditable="true" data-control-name="note" aria-label="Add a note">${secret}</div>
      <button data-control-name="send">Send now</button></div>`);
    const read = await p.evaluate(H.READ_CANDIDATES);
    const asJson = JSON.stringify(read);
    assert.ok(!asJson.includes('Senior Cloud Security Engineer'), asJson);
    const box = read.candidates.find(c => c.typable);
    assert.ok(box, 'the box is still offered as a choice');
    assert.equal(box.label, 'Add a note', 'by its label, not by what is in it');
  } finally { await b.close(); }
});

test('reading the page twice does not leave the first numbering behind', async () => {
  const { chromium } = await import('playwright');
  const exe = process.env.SOURCER_CHROME;
  const b = await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null);
  if (!b) return;
  try {
    const p = await b.newPage();
    await p.setContent(`<div role="dialog">
      <button id="a1">Add a note</button><button id="c1">Cancel</button><button id="s1">Send now</button></div>`);
    await p.evaluate(H.READ_CANDIDATES);
    await p.evaluate(() => { document.getElementById('a1').style.display = 'none'; });
    await p.evaluate(H.READ_CANDIDATES);
    const tags = await p.evaluate(() => [...document.querySelectorAll('[data-sourcer-candidate]')]
      .map(e => `${e.id}=${e.getAttribute('data-sourcer-candidate')}`));
    assert.deepEqual(tags, ['c1=1', 's1=2'], 'the hidden one must not keep a number that now belongs to another');
  } finally { await b.close(); }
});

test('a broken clock does not read as healthy', () => {
  const s = fresh();
  H.laneDown(s, 'connect', 'x');
  s.data.meta.health.connect.at = 'not a date';
  assert.equal(H.laneIsDown(s, 'connect'), true, 'an unreadable time is treated as a problem, not as fine');
});

test('old pictures of LinkedIn do not pile up for ever', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { SCREENSHOT_DIR, ensureDirs } = await import('../src/paths.js');
  ensureDirs();
  for (let i = 0; i < 26; i++) fs.writeFileSync(path.join(SCREENSHOT_DIR, `2026-01-${String(i + 1).padStart(2, '0')}-x.png`), 'x');
  H.pruneShots(20);
  const left = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'));
  assert.equal(left.length, 20);
  assert.ok(left.includes('2026-01-26-x.png'), 'the newest are the ones kept');
  assert.ok(!left.includes('2026-01-01-x.png'));
});

// ---- what the verification pass found. The first two would still have clicked the wrong control.

const withPage = async (html, fn) => {
  const { chromium } = await import('playwright');
  const exe = process.env.SOURCER_CHROME;
  const b = await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null);
  if (!b) return 'skipped';
  try { const p = await b.newPage(); await p.setContent(html); return await fn(p); }
  finally { await b.close(); }
};

const learn = (s, { step = 'sendInviteButton', lane = 'connect', name = 'Jane Doe', candidate, inDialog = true }) => {
  H.askFor(s, { step, lane, why: 'x', lead: { name }, inDialog, candidates: [{ n: 1, ...candidate }] });
  return H.answer(s, 1);
};

test('a learned control is never looked for outside the window it came from', async () => {
  const { firstVisible } = await import('../src/selectors.js');
  // no invite window at all, but the profile behind it has something that says the same thing
  const out = await withPage(`<main><button id="STRAY">Send</button></main>`, async p => {
    const s = fresh();
    learn(s, { candidate: { tag: 'button', name: 'Send', text: 'Send', label: '', data: {} } });
    const r = await H.findOrAsk(p, { page: p, store: s, step: 'sendInviteButton', lane: 'connect',
      shipped: [], name: 'Jane Doe', want: 'send', why: 'x', timeout: 300, firstVisible });
    return r.el ? await r.el.getAttribute('id') : null;
  });
  if (out === 'skipped') return;
  assert.equal(out, null, 'with no invite window, it must find nothing rather than something on the page');
});

test('the message composer is never mistaken for the invite window', async () => {
  const { firstVisible } = await import('../src/selectors.js');
  // a chat bubble is open, and it has its own Send. The invite window comes after it.
  const out = await withPage(`
    <div class="msg-form"><button id="MESSAGE-SEND">Send</button></div>
    <div class="artdeco-modal"><button id="INVITE-SEND">Send</button></div>`, async p => {
    const s = fresh();
    learn(s, { candidate: { tag: 'button', name: 'Send', text: 'Send', label: '', data: {} } });
    const r = await H.findOrAsk(p, { page: p, store: s, step: 'sendInviteButton', lane: 'connect',
      shipped: [], name: 'Jane Doe', want: 'send', why: 'x', timeout: 1500, firstVisible });
    return r.el ? await r.el.getAttribute('id') : null;
  });
  if (out === 'skipped') return;
  assert.equal(out, 'INVITE-SEND', 'sending a message instead of an invitation would be the worst outcome here');
});

test('an older window left on the page does not win over the new one', async () => {
  const { firstVisible } = await import('../src/selectors.js');
  const out = await withPage(`
    <div role="dialog"><button id="STALE">Send</button></div>
    <div class="artdeco-modal"><button id="CURRENT">Send</button></div>`, async p => {
    const s = fresh();
    learn(s, { candidate: { tag: 'button', name: 'Send', text: 'Send', label: '', data: {} } });
    const r = await H.findOrAsk(p, { page: p, store: s, step: 'sendInviteButton', lane: 'connect',
      shipped: [], name: 'Jane Doe', want: 'send', why: 'x', timeout: 1500, firstVisible });
    return r.el ? await r.el.getAttribute('id') : null;
  });
  if (out === 'skipped') return;
  assert.equal(out, 'CURRENT', 'a newly opened window is the one we are in');
});

test('a shipped selector finding the button does not prove the learned one works', async () => {
  const { firstVisible } = await import('../src/selectors.js');
  const out = await withPage(`<div class="artdeco-modal">
    <button id="SHIPPED" aria-label="Send invitation">Send</button></div>`, async p => {
    const s = fresh();
    // what Kai picked no longer matches anything
    learn(s, { candidate: { tag: 'button', name: 'Gone', text: '', label: '', data: { 'data-test-gone': '1' } } });
    const r = await H.findOrAsk(p, { page: p, store: s, step: 'sendInviteButton', lane: 'connect',
      shipped: ['button[aria-label="Send invitation"]'], name: 'Jane Doe', want: 'send', why: 'x', timeout: 600, firstVisible });
    return { id: r.el ? await r.el.getAttribute('id') : null, viaLearned: r.viaLearned };
  });
  if (out === 'skipped') return;
  assert.equal(out.id, 'SHIPPED', 'it still works, using what we shipped with');
  assert.equal(out.viaLearned, false, 'so the dead learned selector stays unproven and can be forgotten');
});

test('every visible control can be picked, whatever it says', () => {
  for (const c of [
    { tag: 'button', name: 'OK', text: 'OK', label: '', data: {} },                       // too short for exact text
    { tag: 'button', name: 'x'.repeat(41), text: 'x'.repeat(41), label: '', data: {} },   // too long
    { tag: 'button', name: 'Ada Lovelace', text: 'Ada Lovelace', label: '', data: {}, id: 'invite-btn' },  // is only their name
  ]) {
    assert.ok(H.selectorsFor(c, { name: 'Ada Lovelace' }).length > 0, JSON.stringify(c));
  }
  // and picking one really does work end to end
  const s = fresh();
  const r = learn(s, { candidate: { tag: 'button', name: 'OK', text: 'OK', label: '', data: {} } });
  assert.equal(r.ok, true, r.problem);
});

test('a note-less invite is only sent when nothing was actually asked', async () => {
  const s = fresh();
  // a question about something else is already waiting, so the note question is never put
  H.askFor(s, { step: 'somethingElse', lane: 'connect', why: 'first', candidates: [{ n: 1, tag: 'button', name: 'a', data: {} }] });
  const second = H.askFor(s, { step: 'noteTextarea', lane: 'connect', why: 'second', candidates: [{ n: 1, tag: 'div', name: 'b', data: {} }] });
  assert.equal(second.step, 'somethingElse', 'the first question stands');
  // findOrAsk reports that it did NOT ask, which is what the caller must act on
  assert.equal(H.pendingQuestion(s).step, 'somethingElse');
});

// ---- fourth audit round ----

test('the control we lost is shown even when the page is full of other things', () => {
  // no invite window: the whole profile is read, and the button that matters is last in the page
  const junk = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, tag: 'a', name: `Nav link ${i}`, text: `Nav link ${i}`, label: '', data: {} }));
  const real = { n: 41, tag: 'button', name: 'Send now', text: 'Send now', label: '', data: { 'data-test-send': '1' }, primary: true };
  const shown = H.orderCandidates([...junk, real], { want: 'send', limit: 12 });
  assert.equal(shown.length, 12, 'a list longer than this is unreadable against the picture');
  assert.equal(shown[0].name, 'Send now', 'and the one we lost is at the top, not over the edge');
  assert.equal(shown[0].pos, 1, 'the number in the list is the number drawn on the picture');
});

test('the page read collects far more than it shows, so the ordering has something to choose from', () => {
  const m = /if \(seen\.length >= (\d+)\) break;/.exec(H.READ_CANDIDATES);
  assert.ok(m && Number(m[1]) >= 40, 'reading only a handful in page order is how the right one gets cut off');
});

test('nothing loose is learned from a page where the invite window was not open', () => {
  // Learned inside the window, a bare "Send" is safe: it is only ever looked for in that window.
  const inside = H.selectorsFor({ tag: 'button', name: 'Send', text: 'Send', label: '', data: {} }, { inDialog: true });
  assert.ok(inside.includes('button:text-is("Send")'));
  // Learned off the open profile, the same selector is looked for across the whole page, where
  // "Send" is a message box, a post, or anything else.
  const outside = H.selectorsFor({ tag: 'button', name: 'Send', text: 'Send', label: '', data: {} }, { inDialog: false });
  assert.deepEqual(outside, [], 'nothing durable about it, so nothing is learned');
  // a control that identifies itself is still fine either way
  const durable = H.selectorsFor({ tag: 'button', name: 'Send', text: 'Send', label: 'Send invitation', data: { 'data-test-send': '1' }, id: 'invite-send' }, { inDialog: false });
  assert.ok(durable.includes('[data-test-send="1"]'));
  assert.ok(durable.includes('button[aria-label="Send invitation"]'));
  assert.ok(!durable.some(x => /text-is/.test(x)), 'still no loose text match outside the window');
});

test('a typing box is not learned as "any box" outside the invite window', () => {
  const c = { tag: 'textarea', name: '', text: '', label: '', data: {}, typable: true };
  assert.ok(H.selectorsFor(c, { inDialog: true }).includes('textarea'), 'inside the window, "the box" is enough');
  assert.deepEqual(H.selectorsFor(c, { inDialog: false }), [], 'across a page it would match a comment box further down');
});

test('picking one off a page with no invite window is refused, in words', () => {
  const s = fresh();
  const r = learn(s, { inDialog: false, candidate: { tag: 'button', name: 'Send', text: 'Send', label: '', data: {} } });
  assert.equal(r.ok, false);
  assert.match(r.problem, /window was not open/);
  assert.equal(H.learnedFor(s, 'sendInviteButton'), null, 'and nothing is left behind');
});

test('"None of these" keeps the page and the picture for Claude, as it says it does', () => {
  const s = fresh();
  H.askFor(s, { step: 'sendInviteButton', lane: 'connect', why: 'moved', shot: 'a.png', candidates: [{ n: 1, tag: 'button', name: 'a', data: {} }] });
  const r = H.answer(s, 'none');
  assert.equal(r.skipped, true);
  assert.equal(H.pendingQuestion(s), null, 'the question is no longer waiting');
  const kept = s.data.meta.healUnsolved;
  assert.equal(kept.step, 'sendInviteButton');
  assert.equal(kept.shot, 'a.png', 'the picture is still findable');
  assert.ok(kept.candidates.length, 'and so is everything the page offered');
});

test('a learned control can be taken back without opening the database', () => {
  const s = fresh();
  learn(s, { candidate: { tag: 'button', name: 'Send now', text: 'Send now', label: '', data: {} } });
  assert.ok(H.learnedFor(s, 'sendInviteButton'));
  const r = H.forget(s, 'sendInviteButton');
  assert.equal(r.ok, true);
  assert.equal(H.learnedFor(s, 'sendInviteButton'), null);
  assert.equal(H.forget(s, 'sendInviteButton').ok, false, 'and saying so twice is not an error to hide');
});

test('two processes learning different controls do not wipe each other out', () => {
  const s = fresh();
  // the dashboard answers a question
  const app = new Store(s.file);
  learn(app, { step: 'noteTextarea', candidate: { tag: 'textarea', name: '', text: '', label: '', data: {}, typable: true } });
  app.save();
  // meanwhile the runner, which loaded before that, confirms a different one and writes health
  learn(s, { step: 'sendInviteButton', candidate: { tag: 'button', name: 'Send now', text: 'Send now', label: '', data: {} } });
  H.laneDown(s, 'inmail', 'unrelated');
  s.save();
  const disk = new Store(s.file);
  assert.ok(H.learnedFor(disk, 'noteTextarea'), 'what the dashboard learned survived');
  assert.ok(H.learnedFor(disk, 'sendInviteButton'), 'and so did what the runner learned');
});

test('one lane going down does not clear another lane that was already down', () => {
  const s = fresh();
  const app = new Store(s.file);
  H.laneDown(app, 'inmail', 'inmail trouble');
  app.save();
  H.laneDown(s, 'connect', 'connect trouble');   // s loaded before the line above
  s.save();
  const disk = new Store(s.file);
  assert.equal(H.laneIsDown(disk, 'inmail'), true);
  assert.equal(H.laneIsDown(disk, 'connect'), true);
});

test('a note that did not reach the box is noticed, without reading what it says', async () => {
  const { noteLanded } = await import('../src/linkedin.js');
  const { chromium } = await import('playwright');
  const exe = process.env.SOURCER_CHROME;
  const b = await chromium.launch(exe ? { executablePath: exe } : {}).catch(() => null);
  if (!b) return;
  try {
    const p = await b.newPage();
    await p.setContent(`<div role="dialog">
      <textarea id="real" style="width:300px;height:60px"></textarea>
      <input id="decoy" readonly style="width:300px;height:30px">
    </div>`);
    const note = 'Hello Ada, good to connect.';
    assert.equal(await noteLanded(p.locator('#real'), note), true, 'the right box holds what was typed');
    // a learned selector can find a box that takes nothing. Typing into it and pressing Send
    // would put out a bare invitation that cannot be taken back.
    assert.equal(await noteLanded(p.locator('#decoy'), note), false);
  } finally { await b.close(); }
});

test('the choices are read out even when LinkedIn stops using a window, and say so', async () => {
  // the invite controls are on the page itself, not in a dialog: Sourcer still reads and shows
  // them, but will not learn a loose text match from them
  const out = await withPage(`<main><button class="artdeco-button--primary" style="width:120px;height:32px">Send now</button></main>`,
    p => p.evaluate(H.READ_CANDIDATES));
  if (out === 'skipped') return;   // no browser on this machine
  assert.equal(out.inDialog, false);
  assert.ok(out.candidates.some(c => c.name === 'Send now'), 'Kai is still shown what is there');
  const s = fresh();
  H.askFor(s, { step: 'sendInviteButton', lane: 'connect', inDialog: out.inDialog, why: 'x', candidates: out.candidates });
  const picked = H.pendingQuestion(s).candidates.find(c => c.name === 'Send now');
  const r = H.answer(s, picked.n);
  assert.equal(r.ok, false, 'and told plainly why it cannot be used, rather than it failing later');
  assert.match(r.problem, /window was not open/);
});

test('a control learned off the open page is only used when it is the only one of its kind', async () => {
  const { firstVisible } = await import('../src/selectors.js');
  const s = fresh();
  // learned from a page with no invite window, so it names itself: an aria-label
  learn(s, { step: 'sendInviteButton', inDialog: false, name: '', candidate: {
    tag: 'button', name: 'Send', text: 'Send', label: 'Send invitation', data: {} } });
  assert.deepEqual(H.learnedFor(s, 'sendInviteButton').selectors, ['button[aria-label="Send invitation"]']);

  // one of them on the page: used
  const found = await withPage(`<main><button aria-label="Send invitation">Send</button></main>`,
    p => H.findOrAsk(p, { page: p, store: s, step: 'sendInviteButton', lane: 'connect', shipped: [], firstVisible }));
  if (found === 'skipped') return;   // no browser on this machine
  assert.equal(found.viaLearned, true);

  // two of them: Sourcer cannot know which is the one, so it asks instead of picking
  const s2 = fresh();
  learn(s2, { step: 'sendInviteButton', inDialog: false, name: '', candidate: {
    tag: 'button', name: 'Send', text: 'Send', label: 'Send invitation', data: {} } });
  const amb = await withPage(
    `<main><button aria-label="Send invitation">Send</button><button aria-label="Send invitation">Send</button></main>`,
    p => H.findOrAsk(p, { page: p, store: s2, step: 'sendInviteButton', lane: 'connect', shipped: [], firstVisible }));
  assert.equal(amb.el, null, 'a guess here is a click on somebody real');
  assert.equal(amb.asked, true, 'and Kai is asked rather than left with nothing');
});
