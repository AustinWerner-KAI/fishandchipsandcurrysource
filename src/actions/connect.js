import * as linkedin from '../linkedin.js';
import { render, checkNote } from '../template.js';
import { remaining, humanPauseMs, sleep, pick } from '../limits.js';
import { log, warn } from '../log.js';

export async function runConnect(page, store, cfg, { max, ops = linkedin, pause = true } = {}) {
  const tz = cfg.workingHours?.timezone;
  let budget = Math.min(remaining(store, cfg.dailyCaps, 'connects', new Date(), tz), max ?? Infinity);
  if (budget <= 0) { log('connect: daily cap reached'); return { sent: 0 }; }

  const candidates = store.leads({ campaign: cfg.name, status: 'new' })
    .filter(l => cfg.autoApprove || l.approved)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.createdAt.localeCompare(b.createdAt));
  if (!candidates.length) { log('connect: nothing approved and waiting'); return { sent: 0 }; }

  let sent = 0;
  for (const lead of candidates) {
    if (budget <= 0) break;
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
      store.setStatus(lead.url, 'error', { error: e.message });
      store.save();
      continue;
    }
    store.recordAction('profileViews', lead.url);
    if (r.info?.name && !lead.name) { lead.name = r.info.name; lead.firstName = r.info.firstName; }
    if (r.info?.headline && !lead.headline) lead.headline = r.info.headline;

    switch (r.result) {
      case 'sent':
        store.setStatus(lead.url, 'invited', { invitedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() });
        store.recordAction('connects', lead.url, { note });
        sent++; budget--;
        log(`invited ${lead.name || lead.url}`);
        break;
      case 'already-connected':
        store.setStatus(lead.url, 'accepted', { acceptedAt: new Date().toISOString(), notes: [lead.notes, 'was already a 1st degree connection'].filter(Boolean).join(' | ') });
        log(`already connected: ${lead.name || lead.url}`);
        break;
      case 'pending':
        store.setStatus(lead.url, 'invited', { invitedAt: lead.invitedAt || new Date().toISOString() });
        log(`already pending: ${lead.name || lead.url}`);
        break;
      case 'weekly-limit':
        warn('LinkedIn weekly invitation limit hit. Stopping connects until next week.');
        store.recordAction('weeklyLimit', lead.url);
        store.save();
        return { sent, weeklyLimit: true };
      case 'email-required':
        store.setStatus(lead.url, 'skipped', { error: 'LinkedIn asks for their email to connect' });
        break;
      case 'no-button':
        store.setStatus(lead.url, 'skipped', { error: 'no Connect button on profile' });
        break;
      default:
        store.setStatus(lead.url, 'error', { error: 'send not confirmed' });
    }
    store.save();
    if (pause) await sleep(humanPauseMs(cfg.pauseBetweenActionsSec));
  }
  log(`connect: ${sent} sent this pass`);
  return { sent };
}
