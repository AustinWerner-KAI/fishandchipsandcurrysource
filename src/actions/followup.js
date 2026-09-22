import * as linkedin from '../linkedin.js';
import { goto, humanScroll } from '../browser.js';
import { render } from '../template.js';
import { remaining, humanPauseMs, sleep } from '../limits.js';
import { log, warn } from '../log.js';

const DAY = 86400000;

export async function ensureOwnName(page, store, ops = linkedin) {
  if (store.data.meta.ownName) return store.data.meta.ownName;
  const name = await ops.readOwnName(page);
  if (name) { store.data.meta.ownName = name; store.save(); }
  return name;
}

// Cheap acceptance sweep: one page listing recent connections, matched against invited leads.
export async function sweepAcceptances(page, store, cfg) {
  const invited = store.leads({ campaign: cfg.name, status: 'invited' });
  if (!invited.length) return 0;
  await goto(page, 'https://www.linkedin.com/mynetwork/invite-connect/connections/');
  await humanScroll(page, { steps: 6 });
  const slugs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('main a[href*="/in/"]'))
      .map(a => (a.getAttribute('href').match(/\/in\/([^/?#]+)/) || [])[1])
      .filter(Boolean));
  const set = new Set(slugs.map(s => decodeURIComponent(s).toLowerCase()));
  let n = 0;
  for (const l of invited) {
    const slug = (l.url.match(/\/in\/([^/]+)/) || [])[1];
    if (slug && set.has(slug.toLowerCase())) {
      store.setStatus(l.url, 'accepted', { acceptedAt: new Date().toISOString() });
      log(`accepted: ${l.name || l.url}`);
      n++;
    }
  }
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
    return { text: q.text, source: 'queue', note: q.note };
  }
  if (cfg.mode !== 'candidates') return null;
  const stepIndex = lead.messages.length;
  const step = cfg.followUps[stepIndex];
  if (!step) return null;
  const base = lead.messages.length ? lead.messages[lead.messages.length - 1].at : lead.acceptedAt;
  if (!base) return null;
  if (new Date(base).getTime() + step.afterDays * DAY > now.getTime()) return null;
  return { text: render(step.text, lead), source: 'step', stepIndex };
}

function markReplied(store, lead, thread) {
  store.setStatus(lead.url, 'replied', { repliedAt: new Date().toISOString(), lastReply: thread.lastText?.slice(0, 500) || '' });
  log(`REPLY from ${lead.name || lead.url}: ${thread.lastText?.slice(0, 120)}`);
}

export async function runMessages(page, store, cfg, { max, ops = linkedin, pause = true } = {}) {
  const tz = cfg.workingHours?.timezone;
  let budget = Math.min(remaining(store, cfg.dailyCaps, 'messages', new Date(), tz), max ?? Infinity);
  if (budget <= 0) { log('messages: daily cap reached'); return { sent: 0 }; }
  const ownName = await ensureOwnName(page, store, ops);
  const now = new Date();
  const due = store.leads({ campaign: cfg.name, status: ['accepted', 'messaged'] })
    .map(l => ({ lead: l, msg: dueMessage(l, cfg, now) }))
    .filter(x => x.msg);
  if (!due.length) { log('messages: nothing due'); return { sent: 0 }; }

  let sent = 0;
  for (const { lead, msg } of due) {
    if (budget <= 0) break;
    let t;
    try {
      t = await ops.openThread(page, lead.url, ownName);
    } catch (e) {
      if (e.name === 'CheckpointError' || e.name === 'NotLoggedInError') throw e;
      warn('open thread failed', lead.url, e.message);
      continue;
    }
    store.recordAction('profileViews', lead.url);
    lead.lastCheckedAt = new Date().toISOString();
    if (!t.opened) {
      if (t.reason === 'not-connected') {
        store.setStatus(lead.url, 'skipped', { error: 'no longer a 1st degree connection' });
      } else {
        warn(`could not open thread for ${lead.url}: ${t.reason}`);
      }
      store.save();
      if (pause) await sleep(humanPauseMs([10, 30]));
      continue;
    }
    if (t.lastFrom === 'them') {
      markReplied(store, lead, t);
      await ops.closeThread(page);
      store.save();
      if (pause) await sleep(humanPauseMs([10, 30]));
      continue;
    }
    const ok = await ops.sendMessageInOpenThread(page, t.editor, msg.text);
    await ops.closeThread(page);
    if (!ok) {
      warn('message not confirmed sent', lead.url);
      store.save();
      continue;
    }
    if (msg.source === 'queue') lead.queue.shift();
    lead.messages.push({ step: msg.stepIndex ?? null, text: msg.text, at: new Date().toISOString(), note: msg.note || '' });
    store.setStatus(lead.url, 'messaged');
    store.recordAction('messages', lead.url);
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
  const tz = cfg.workingHours?.timezone;
  let budget = Math.min(remaining(store, cfg.dailyCaps, 'profileViews', new Date(), tz), max);
  const ownName = await ensureOwnName(page, store, ops);
  const now = Date.now();
  const list = store.leads({ campaign: cfg.name, status: ['messaged', 'accepted'] })
    .filter(l => !dueMessage(l, cfg))
    .filter(l => !l.lastCheckedAt || now - new Date(l.lastCheckedAt).getTime() > DAY)
    .filter(l => l.messages.length || l.status === 'accepted')
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  let replies = 0;
  for (const lead of list) {
    if (budget <= 0) break;
    let t;
    try { t = await ops.openThread(page, lead.url, ownName); }
    catch (e) {
      if (e.name === 'CheckpointError' || e.name === 'NotLoggedInError') throw e;
      warn('reply check failed', lead.url, e.message); continue;
    }
    budget--;
    store.recordAction('profileViews', lead.url);
    lead.lastCheckedAt = new Date().toISOString();
    if (t.opened) {
      if (t.lastFrom === 'them') { markReplied(store, lead, t); replies++; }
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
