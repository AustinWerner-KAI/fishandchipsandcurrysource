import * as linkedin from '../linkedin.js';
import { sameText } from '../linkedin.js';
import { goto, humanScroll, snap } from '../browser.js';
import { renderChecked } from '../template.js';
import { ACCOUNT_TZ, remaining, humanPauseMs, sleep, pauseFor, withinWorkingHours } from '../limits.js';
import { log, warn } from '../log.js';
import { stopRequested } from '../stop.js';
import { notify } from '../notify.js';
import { isRecruiterUrl } from '../store.js';
import { resolveRecruiterLead } from './connect.js';
import { allClients, offLimits } from '../offlimits.js';

// Someone found to work at a client: nothing more goes to them.
function markOffLimits(store, lead, client) {
  store.setStatus(lead.url, 'skipped', { error: `works at your client ${client.name}`, offLimits: client.name });
  log(`${lead.name || lead.url} works at your client ${client.name}: nothing sent`);
}

const DAY = 86400000;
const checked = (t, lead, role) => { const r = renderChecked(t, lead, role); return r.problem ? r : { text: r.text }; };
const HOUR = 3600000;

export async function ensureOwnName(page, store, ops = linkedin) {
  if (store.data.meta.ownName) return store.data.meta.ownName;
  const name = await ops.readOwnName(page);
  if (name) { store.refresh(); store.data.meta.ownName = name; store.save(); }
  return name;
}

// Cheap acceptance sweep: one page listing recent connections, matched against invited leads.
// Runs at most once every cfg.acceptanceCheckEveryHours.
export async function sweepAcceptances(page, store, cfg, { force = false } = {}) {
  store.load();
  const invited = store.leads({ campaign: cfg.name, status: 'invited' });
  if (!invited.length) return 0;
  const last = store.data.meta.lastAcceptanceSweep;
  const every = (cfg.acceptanceCheckEveryHours ?? 3) * HOUR;
  if (!force && last && Date.now() - new Date(last).getTime() < every) return 0;

  // stamp the sweep first, so a page that keeps failing is not retried on every cycle
  store.refresh(); store.data.meta.lastAcceptanceSweep = new Date().toISOString(); store.save();
  await goto(page, 'https://www.linkedin.com/mynetwork/invite-connect/connections/');
  await humanScroll(page, { steps: 6 });
  const slugs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('main a[href*="/in/"]'))
      .map(a => (a.getAttribute('href').match(/\/in\/([^/?#]+)/) || [])[1])
      .filter(Boolean));
  const set = new Set(slugs.map(s => decodeURIComponent(s).toLowerCase()));
  if (!set.size) await snap(page, 'connections-empty');
  store.refresh();
  let n = 0;
  for (const l of store.leads({ campaign: cfg.name, status: 'invited' })) {
    const slug = (l.url.match(/\/in\/([^/]+)/) || [])[1];
    if (slug && set.has(slug.toLowerCase())) {
      store.setStatus(l.url, 'accepted', { acceptedAt: new Date().toISOString() });
      log(`accepted: ${l.name || l.url}`);
      n++;
    }
  }
  store.data.meta.lastAcceptanceSweep = new Date().toISOString();
  store.save();
  log(`acceptance sweep: ${n} newly accepted (${set.size} recent connections seen)`);
  return n;
}

// What, if anything, is due to go to this lead right now.
export function dueMessage(lead, cfg, now = new Date()) {
  if (['replied', 'done', 'skipped', 'error', 'new', 'invited'].includes(lead.status)) return null;
  const q = lead.queue?.[0];
  if (q) {
    if (q.notBefore && new Date(q.notBefore) > now) return null;
    return { text: q.text, source: 'queue', note: q.note, resume: !!q.resume };
  }
  // once they have ever replied, only Kai's own queued messages go; no template, in any lane
  if (lead.repliedAt) return null;
  // 1st connections Kai chose to message: one message, one follow-up, then stop
  if (lead.direct) {
    if (lead.direct.stopped) return null;
    const fd = cfg.firstDegree || {};
    const steps = [{ days: 0, text: fd.message }, { days: fd.followUpAfterDays ?? 4, text: fd.followUp }];
    const done = lead.messages.filter(m => m.lane === 'direct');
    const step = steps[done.length];
    if (!step || !step.text) return null;
    const base = done.length ? done[done.length - 1].at : lead.direct.at;
    if (new Date(base).getTime() + step.days * DAY > now.getTime()) return null;
    return { ...checked(step.text, lead, cfg.role), source: 'step', stepIndex: done.length, lane: 'direct' };
  }
  if (cfg.mode !== 'candidates') return null;
  if (lead.preexisting) return null;   // they were already a contact; templates would read wrong
  if (lead.inmail?.sentAt) return null; // already in an InMail conversation; connection templates would read wrong
  const stepIndex = lead.messages.length;
  const step = cfg.followUps[stepIndex];
  if (!step) return null;
  const base = lead.messages.length ? lead.messages[lead.messages.length - 1].at : lead.acceptedAt;
  if (!base) return null;
  if (new Date(base).getTime() + (step.afterDays || 0) * DAY + (step.afterHours || 0) * 3600000 > now.getTime()) return null;
  return { ...checked(step.text, lead, cfg.role), source: 'step', stepIndex };
}

// LinkedIn says there is no connection. That only means something for somebody who was one:
// a 1st degree contact, or an invite that was accepted. Anyone reached another way (an InMail to
// a 2nd or 3rd degree candidate) was never connected in the first place, and closing them buries
// live outreach in the Closed list with a reason that reads like their fault.
function closeIfWasConnected(store, lead) {
  const wasConnected = lead.degree === '1st' || lead.direct || lead.preexisting || lead.acceptedAt;
  if (!wasConnected) {
    warn(`${lead.name || lead.url}: not a connection, which is expected for ${lead.channel || 'this lane'}. Left as it was.`);
    return false;
  }
  store.setStatus(lead.url, 'skipped', { error: 'no longer a 1st degree connection' });
  return true;
}

function markReplied(store, lead, thread) {
  store.setStatus(lead.url, 'replied', { repliedAt: new Date().toISOString(), lastReply: thread.lastText?.slice(0, 500) || '' });
  log(`REPLY from ${lead.name || lead.url}: ${thread.lastText?.slice(0, 120)}`);
  notify(`${lead.name || 'Someone'} replied`, thread.lastText || 'Open Sourcer to see it.');
}

function recordSent(store, lead, msg) {
  // take out the message that went, not whatever is first now (Kai may have removed one meanwhile)
  if (msg.source === 'queue') { const i = lead.queue.findIndex(q => q.text === msg.text); if (i >= 0) lead.queue.splice(i, 1); }
  lead.messages.push({ step: msg.stepIndex ?? null, text: msg.text, at: new Date().toISOString(), note: msg.note || '', ...(msg.lane ? { lane: msg.lane } : {}) });
  store.setStatus(lead.url, 'messaged');
  store.recordAction('messages', lead.url);
}

export async function runMessages(page, store, cfg, { max, ops = linkedin, pause = true } = {}) {
  const tz = ACCOUNT_TZ;   // caps are per account, not per role
  store.load();
  let budget = Math.min(remaining(store, cfg.dailyCaps, 'messages', new Date(), tz), max ?? Infinity);
  if (budget <= 0) { log('messages: daily cap reached'); return { sent: 0 }; }
  const ownName = await ensureOwnName(page, store, ops);
  if (!ownName) { warn('messages: could not read your own LinkedIn name, so replies cannot be told apart. Not sending.'); return { sent: 0 }; }
  const now = new Date();
  const due = store.leads({ campaign: cfg.name, status: ['accepted', 'messaged'] })
    .map(l => ({ lead: l, msg: dueMessage(l, cfg, now) }))
    .filter(x => x.msg);
  if (!due.length) { log('messages: nothing due'); return { sent: 0 }; }

  const clients = allClients();
  let sent = 0;
  for (const { lead: picked } of due) {
    if (budget <= 0 || stopRequested()) break;
    if (!withinWorkingHours(cfg.workingHours)) { log('messages: working hours over'); break; }
    if (remaining(store, cfg.dailyCaps, 'profileViews', new Date(), tz) <= 0) { log('messages: profile view cap reached'); break; }

    // fresh copy: a reply may have been recorded, or the queue edited, since the list was built
    let lead = store.refresh(picked.url);
    const msg = lead && dueMessage(lead, cfg, new Date());
    if (!msg) continue;
    // Kai's own replies still go; nothing automatic goes to someone at a client
    const own = msg.source === 'queue' && msg.resume;
    const listed = !own && offLimits(lead, clients);
    if (listed) { markOffLimits(store, lead, listed); store.save(); continue; }
    if (msg.problem) {
      // no message goes out with a gap where the name should be
      if (lead.error !== msg.problem) { lead.error = msg.problem; store.save(); warn(`${lead.name || lead.url}: ${msg.problem}, not sent`); }
      continue;
    }

    // found in Recruiter: look up their normal profile first (one more view)
    if (isRecruiterUrl(lead.url)) {
      if (remaining(store, cfg.dailyCaps, 'profileViews', new Date(), tz) < 2) { log('messages: profile view cap reached'); break; }
      lead = await resolveRecruiterLead(page, store, lead, ops, pause);
      if (!lead) continue;
      if (!dueMessage(lead, cfg, new Date())) continue;          // changed in the app during the lookup
    }

    let t;
    try {
      t = await ops.openThread(page, lead.url, ownName, { clients: own ? [] : clients });
    } catch (e) {
      if (e.name === 'CheckpointError' || e.name === 'NotLoggedInError') throw e;
      warn('open thread failed', lead.url, e.message);
      store.recordAction('profileViews', lead.url);   // the profile page still loaded
      store.save();
      if (pause) await pauseFor(humanPauseMs([10, 30]));
      continue;
    }
    lead = store.refresh(lead.url) || lead;
    store.recordAction('profileViews', lead.url);
    lead.lastCheckedAt = new Date().toISOString();
    if (!t.opened) {
      if (t.reason === 'off-limits') markOffLimits(store, lead, t.client);
      else if (t.reason === 'not-connected') {
        closeIfWasConnected(store, lead);
      } else {
        warn(`could not open thread for ${lead.url}: ${t.reason} (screenshot saved, nothing sent)`);
      }
      store.save();
      if (pause) await pauseFor(humanPauseMs([10, 30]));
      continue;
    }
    // Once they have written, only Kai's own reply (a queued message marked resume) may go.
    // No template or older queued message ever goes again, even after Kai answered by hand.
    const kaiReply = msg.source === 'queue' && msg.resume;
    if (msg.lane === 'direct' && msg.stepIndex === 0 && t.lastFrom === 'them') {
      // an old chat where they wrote last: a cold message would read wrong
      store.setStatus(lead.url, 'skipped', { error: 'they wrote last in an older chat: message them by hand', autoSkip: true });
      await ops.closeThread(page);
      store.save();
      continue;
    }
    // 1st connections follow-up: only when our own first message is still the last word.
    // If Kai has written by hand since, the conversation is his: the lane stops.
    if (msg.lane === 'direct' && msg.stepIndex > 0 && t.lastFrom !== 'them') {
      const first = [...lead.messages].reverse().find(m => m.lane === 'direct');
      if (!(t.lastFrom === 'me' && first && sameText(t.lastText, first.text))) {
        lead.direct = { ...lead.direct, stopped: 'you are talking with them by hand' };
        log(`${lead.name || lead.url}: you have written to them by hand, no follow-up sent`);
        await ops.closeThread(page);
        store.save();
        continue;
      }
    }
    // 1st connections: an old chat may hold their earlier words, so only a new last word counts
    const theyReplied = msg.lane === 'direct' ? t.lastFrom === 'them' : (t.theySpoke || t.lastFrom === 'them');
    if (theyReplied && !kaiReply) {
      markReplied(store, lead, t);
      await ops.closeThread(page);
      store.save();
      if (pause) await pauseFor(humanPauseMs([10, 30]));
      continue;
    }
    if (t.lastFrom === 'me' && sameText(t.lastText, msg.text)) {
      // an earlier pass sent this but could not confirm it; do not send twice
      log(`already sent to ${lead.name || lead.url}, recording it`);
      recordSent(store, lead, msg);
      await ops.closeThread(page);
      store.save();
      continue;
    }
    let ok = false;
    try {
      ok = await ops.sendMessageInOpenThread(page, t.editor, msg.text, ownName, t.scope);
    } catch (e) {
      if (e.name === 'CheckpointError' || e.name === 'NotLoggedInError') throw e;
      warn('send failed', lead.url, e.message);
    }
    await ops.closeThread(page);
    if (!ok) {
      warn('message not confirmed sent', lead.url);
      store.save();
      continue;
    }
    lead = store.refresh(lead.url) || lead;
    recordSent(store, lead, msg);
    sent++; budget--;
    log(`messaged ${lead.name || lead.url} (${msg.source})`);
    store.save();
    if (pause) await pauseFor(humanPauseMs(cfg.pauseBetweenActionsSec));
  }
  log(`messages: ${sent} sent this pass`);
  return { sent };
}

// Reply sweep for leads with nothing due: open the thread, look at who spoke last.
// Throttled to once a day per lead and to the profile view budget.
export async function sweepReplies(page, store, cfg, { max = 15, ops = linkedin, pause = true } = {}) {
  const tz = ACCOUNT_TZ;   // caps are per account, not per role
  store.load();
  let budget = Math.min(remaining(store, cfg.dailyCaps, 'profileViews', new Date(), tz), max);
  const ownName = await ensureOwnName(page, store, ops);
  if (!ownName) { warn('reply sweep: own name unknown, skipping'); return 0; }
  const now = Date.now();
  const list = store.leads({ campaign: cfg.name, status: 'messaged' })
    // Somebody reached by InMail is 2nd or 3rd degree, which is why they got an InMail. There is
    // no LinkedIn thread to open, and their reply lands in Recruiter, not here.
    .filter(l => l.channel !== 'inmail' && !l.inmail?.sentAt)
    .filter(l => !dueMessage(l, cfg))
    .filter(l => !l.lastCheckedAt || now - new Date(l.lastCheckedAt).getTime() > DAY)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  let replies = 0;
  for (const picked of list) {
    if (budget <= 0 || stopRequested()) break;
    if (!withinWorkingHours(cfg.workingHours)) break;
    let t;
    try { t = await ops.openThread(page, picked.url, ownName); }
    catch (e) {
      if (e.name === 'CheckpointError' || e.name === 'NotLoggedInError') throw e;
      warn('reply check failed', picked.url, e.message);
      budget--;
      store.refresh();
      store.recordAction('profileViews', picked.url);
      store.save();
      if (pause) await pauseFor(humanPauseMs([10, 40]));
      continue;
    }
    budget--;
    const lead = store.refresh(picked.url) || picked;
    store.recordAction('profileViews', lead.url);
    lead.lastCheckedAt = new Date().toISOString();
    if (t.opened) {
      if (t.lastFrom === 'them' || (t.theySpoke && !lead.queue.length && !lead.direct)) { markReplied(store, lead, t); replies++; }
      else if ((cfg.mode === 'candidates' || lead.direct) && !lead.queue.length && lead.messages.length >= (lead.direct ? 2 : cfg.followUps.length) && lead.messages.length
        && now - new Date(lead.messages[lead.messages.length - 1].at).getTime() > 14 * DAY) {
        store.setStatus(lead.url, 'done');
      }
      await ops.closeThread(page);
    } else if (t.reason === 'not-connected') {
      closeIfWasConnected(store, lead);
    }
    store.save();
    if (pause) await pauseFor(humanPauseMs([10, 40]));
  }
  log(`reply sweep: ${replies} new replies`);
  return replies;
}
