import * as linkedin from '../linkedin.js';
import { render, checkNote } from '../template.js';
import { remaining, humanPauseMs, sleep, pick, withinWorkingHours } from '../limits.js';
import { log, warn } from '../log.js';

const WEEK = 7 * 86400000;

export function weeklyLimitActive(store, now = Date.now()) {
  return store.actionsSince(new Date(now - WEEK).toISOString(), 'weeklyLimit').length > 0;
}

export async function runConnect(page, store, cfg, { max, ops = linkedin, pause = true } = {}) {
  const tz = cfg.workingHours?.timezone;
  store.load();
  if (weeklyLimitActive(store)) { log('connect: LinkedIn weekly invitation limit was hit in the last 7 days, not sending'); return { sent: 0, weeklyLimit: true }; }
  let budget = Math.min(remaining(store, cfg.dailyCaps, 'connects', new Date(), tz), max ?? Infinity);
  if (budget <= 0) { log('connect: daily cap reached'); return { sent: 0 }; }

  const candidates = store.leads({ campaign: cfg.name, status: 'new' })
    .filter(l => cfg.autoApprove || l.approved)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.createdAt.localeCompare(b.createdAt));
  if (!candidates.length) { log('connect: nothing approved and waiting'); return { sent: 0 }; }

  let sent = 0;
  for (const picked of candidates) {
    if (budget <= 0) break;
    if (!withinWorkingHours(cfg.workingHours)) { log('connect: working hours over'); break; }
    if (remaining(store, cfg.dailyCaps, 'profileViews', new Date(), tz) <= 0) { log('connect: profile view cap reached'); break; }

    // fresh copy: the dashboard may have un-approved this person since the list was built
    const lead = store.refresh(picked.url);
    if (!lead || lead.status !== 'new' || !(cfg.autoApprove || lead.approved)) continue;

    const template = pick(cfg.connectionNotes);
    const note = template ? render(template, lead) : '';
    const problems = note ? checkNote(note, cfg.noteMaxLength) : [];
    if (problems.length) { warn('note rejected', problems, note); continue; }

    let r;
    try {
      r = await ops.sendConnectionRequest(page, lead.url, note);
    } catch (e) {
      if (e.name === 'CheckpointError' || e.name === 'NotLoggedInError') throw e;
      warn('connect failed', lead.url, e.message);
      store.refresh();
      store.setStatus(lead.url, 'error', { error: e.message });
      store.recordAction('profileViews', lead.url);
      store.save();
      continue;
    }
    const cur = store.refresh(lead.url) || lead;
    store.recordAction('profileViews', cur.url);
    if (r.info?.name && !cur.name) { cur.name = r.info.name; cur.firstName = r.info.firstName; }
    if (r.info?.headline && !cur.headline) cur.headline = r.info.headline;

    switch (r.result) {
      case 'sent':
        store.setStatus(cur.url, 'invited', { invitedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() });
        store.recordAction('connects', cur.url, { note: r.noteSent ? note : '' });
        sent++; budget--;
        log(`invited ${cur.name || cur.url}`);
        break;
      case 'already-connected':
        // already in the network before this campaign: no "thanks for connecting" template, but queued messages still work
        store.setStatus(cur.url, 'accepted', { acceptedAt: new Date().toISOString(), preexisting: true, notes: [cur.notes, 'was already a 1st degree connection'].filter(Boolean).join(' | ') });
        log(`already connected: ${cur.name || cur.url}`);
        break;
      case 'pending':
        store.setStatus(cur.url, 'invited', { invitedAt: cur.invitedAt || new Date().toISOString() });
        log(`already pending: ${cur.name || cur.url}`);
        break;
      case 'weekly-limit':
        warn('LinkedIn weekly invitation limit hit. No more connection requests for 7 days.');
        store.recordAction('weeklyLimit', cur.url);
        store.save();
        return { sent, weeklyLimit: true };
      case 'email-required':
        store.setStatus(cur.url, 'skipped', { error: 'LinkedIn asks for their email to connect' });
        break;
      case 'no-button':
        store.setStatus(cur.url, 'skipped', { error: 'no Connect button on profile' });
        break;
      default:
        store.setStatus(cur.url, 'error', { error: 'send not confirmed' });
    }
    store.save();
    if (pause) await sleep(humanPauseMs(cfg.pauseBetweenActionsSec));
  }
  log(`connect: ${sent} sent this pass`);
  return { sent };
}
