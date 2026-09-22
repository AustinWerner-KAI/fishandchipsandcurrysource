import * as linkedin from '../linkedin.js';
import { sameText } from '../linkedin.js';
import { goto, humanScroll, snap } from '../browser.js';
import { render } from '../template.js';
import { ACCOUNT_TZ, remaining, humanPauseMs, sleep, withinWorkingHours } from '../limits.js';
import { log, warn } from '../log.js';

const DAY = 86400000;
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
  if (cfg.mode !== 'candidates') return null;
  if (lead.preexisting) return null;   // they were already a contact; templates would read wrong
  if (lead.inmail?.sentAt) return null; // already in an InMail conversation; connection templates would read wrong
  const stepIndex = lead.messages.length;
  const step = cfg.followUps[stepIndex];
  if (!step) return null;
  const base = lead.messages.length ? lead.messages[lead.messages.length - 1].at : lead.acceptedAt;
  if (!base) return null;
  if (new Date(base).getTime() + (step.afterDays || 0) * DAY + (step.afterHours || 0) * 3600000 > now.getTime()) return null;
  return { text: render(step.text, lead, cfg.role), source: 'step', stepIndex };
}

function markReplied(store, lead, thread) {
  store.setStatus(lead.url, 'replied', { repliedAt: new Date().toISOString(), lastReply: thread.lastText?.slice(0, 500) || '' });
  log(`REPLY from ${lead.name || lead.url}: ${thread.lastText?.slice(0, 120)}`);
}

function recordSent(store, lead, msg) {
  if (msg.source === 'queue') lead.queue.shift();
  lead.messages.push({ step: msg.stepIndex ?? null, text: msg.text, at: new Date().toISOString(), note: msg.note || '' });
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

  let sent = 0;
  for (const { lead: picked } of due) {
    if (budget <= 0) break;
    if (!withinWorkingHours(cfg.workingHours)) { log('messages: working hours over'); break; }
    if (remaining(store, cfg.dailyCaps, 'profileViews', new Date(), tz) <= 0) { log('messages: profile view cap reached'); break; }

    // fresh copy: a reply may have been recorded, or the queue edited, since the list was built
    let lead = store.refresh(picked.url);
    const msg = lead && dueMessage(lead, cfg, new Date());
    if (!msg) continue;

    let t;
    try {
      t = await ops.openThread(page, lead.url, ownName);
    } catch (e) {
      if (e.name === 'CheckpointError' || e.name === 'NotLoggedInError') throw e;
      warn('open thread failed', lead.url, e.message);
      store.recordAction('profileViews', lead.url);   // the profile page still loaded
      store.save();
      if (pause) await sleep(humanPauseMs([10, 30]));
      continue;
    }
    lead = store.refresh(lead.url) || lead;
    store.recordAction('profileViews', lead.url);
    lead.lastCheckedAt = new Date().toISOString();
    if (!t.opened) {
      if (t.reason === 'not-connected') {
        store.setStatus(lead.url, 'skipped', { error: 'no longer a 1st degree connection' });
      } else {
        warn(`could not open thread for ${lead.url}: ${t.reason} (screenshot saved, nothing sent)`);
      }
      store.save();
      if (pause) await sleep(humanPauseMs([10, 30]));
      continue;
    }
    // Once they have written, only Kai's own reply (a queued message marked resume) may go.
    // No template or older queued message ever goes again, even after Kai answered by hand.
    const kaiReply = msg.source === 'queue' && msg.resume;
    if ((t.theySpoke || t.lastFrom === 'them') && !kaiReply) {
      markReplied(store, lead, t);
      await ops.closeThread(page);
      store.save();
      if (pause) await sleep(humanPauseMs([10, 30]));
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
    if (pause) await sleep(humanPauseMs(cfg.pauseBetweenActionsSec));
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
    .filter(l => !dueMessage(l, cfg))
    .filter(l => !l.lastCheckedAt || now - new Date(l.lastCheckedAt).getTime() > DAY)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  let replies = 0;
  for (const picked of list) {
    if (budget <= 0) break;
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
      if (pause) await sleep(humanPauseMs([10, 40]));
      continue;
    }
    budget--;
    const lead = store.refresh(picked.url) || picked;
    store.recordAction('profileViews', lead.url);
    lead.lastCheckedAt = new Date().toISOString();
    if (t.opened) {
      if (t.lastFrom === 'them' || (t.theySpoke && !lead.queue.length)) { markReplied(store, lead, t); replies++; }
      else if (cfg.mode === 'candidates' && !lead.queue.length && lead.messages.length >= cfg.followUps.length && lead.messages.length
        && now - new Date(lead.messages[lead.messages.length - 1].at).getTime() > 14 * DAY) {
        store.setStatus(lead.url, 'done');
      }
      await ops.closeThread(page);
    } else if (t.reason === 'not-connected') {
      store.setStatus(lead.url, 'skipped', { error: 'no longer a 1st degree connection' });
    }
    store.save();
    if (pause) await sleep(humanPauseMs([10, 40]));
  }
  log(`reply sweep: ${replies} new replies`);
  return replies;
}
