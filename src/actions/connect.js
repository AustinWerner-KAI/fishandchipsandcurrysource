import * as linkedin from '../linkedin.js';
import { renderChecked, checkNote } from '../template.js';
import { ACCOUNT_TZ, remaining, humanPauseMs, sleep, pick, withinWorkingHours } from '../limits.js';
import { log, warn } from '../log.js';
import { isRecruiterUrl } from '../store.js';
import { cleanLead } from '../rank.js';
import { allClients, offLimits } from '../offlimits.js';

const WEEK = 7 * 86400000;

export function weeklyLimitActive(store, now = Date.now()) {
  return store.actionsSince(new Date(now - WEEK).toISOString(), 'weeklyLimit').length > 0;
}

// Swaps a Recruiter find for their normal /in/ profile (one profile view). Returns the lead, or null
// when it could not be found or the person is already on file (never contacted twice).
export async function resolveRecruiterLead(page, store, lead, ops = linkedin, pause = true) {
  if (!ops.publicUrlFor) ops = { ...ops, publicUrlFor: (await import('./recruiter.js')).publicUrlFor };
  let pub = null, netErr = null;
  try { pub = await ops.publicUrlFor(page, lead.url); }
  catch (e) { if (e.name === 'CheckpointError' || e.name === 'NotLoggedInError') throw e; netErr = e; warn('recruiter lookup failed', lead.url, e.message); }
  store.refresh();
  store.recordAction('profileViews', lead.url);
  if (!pub) {
    const cur = store.get(lead.url) || lead;
    cur.lookupFails = (cur.lookupFails || 0) + 1;
    // a slow or dropped page is tried again next pass; three misses in a row and Kai is told
    if (cur.lookupFails >= 3 || !netErr) store.setStatus(lead.url, 'error', { error: 'could not find their normal LinkedIn profile from Recruiter' });
    store.save();
    if (pause) await sleep(humanPauseMs([20, 60]));
    return null;
  }
  const r = store.rekey(lead.url, pub);
  if (r.conflict) {
    store.setStatus(lead.url, 'skipped', { error: `already on file (${r.conflict.campaign}, ${r.conflict.status})` });
    store.save();
    log(`${lead.name}: already on file as ${pub}, not contacted again`);
    return null;
  }
  store.save();
  log(`found ${lead.name}: ${pub}`);
  if (pause) await sleep(humanPauseMs([8, 20]));
  return r.lead;
}

export async function runConnect(page, store, cfg, { max, ops = linkedin, pause = true } = {}) {
  const tz = ACCOUNT_TZ;   // caps are per account, not per role
  store.load();
  if (weeklyLimitActive(store)) { log('connect: LinkedIn weekly invitation limit was hit in the last 7 days, not sending'); return { sent: 0, weeklyLimit: true }; }
  let budget = Math.min(remaining(store, cfg.dailyCaps, 'connects', new Date(), tz), max ?? Infinity);
  if (budget <= 0) { log('connect: daily cap reached'); return { sent: 0 }; }

  const clients = allClients();
  const candidates = store.leads({ campaign: cfg.name, status: 'new' })
    .filter(l => cfg.autoApprove || l.approved)
    .filter(l => cleanLead(l).degree !== '1st')          // already connected: they go in the 1st connections list
    .filter(l => !offLimits(l, clients))                 // works at a client: never contacted
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.createdAt.localeCompare(b.createdAt));
  if (!candidates.length) { log('connect: nothing approved and waiting'); return { sent: 0 }; }

  let sent = 0;
  for (const picked of candidates) {
    if (budget <= 0) break;
    if (!withinWorkingHours(cfg.workingHours)) { log('connect: working hours over'); break; }
    // a Recruiter find costs two views: the Recruiter profile, then their normal profile
    if (remaining(store, cfg.dailyCaps, 'profileViews', new Date(), tz) < (isRecruiterUrl(picked.url) ? 2 : 1)) { log('connect: profile view cap reached'); break; }

    // fresh copy: the dashboard may have un-approved this person since the list was built
    let lead = store.refresh(picked.url);
    if (!lead || lead.status !== 'new' || !(cfg.autoApprove || lead.approved)) continue;

    // Found in Recruiter: look up their normal profile first (one profile view)
    if (isRecruiterUrl(lead.url)) {
      lead = await resolveRecruiterLead(page, store, lead, ops, pause);
      if (!lead) continue;
    }

    const template = pick(cfg.connectionNotes);
    const { text: note, problem } = template ? renderChecked(template, lead, cfg.role) : { text: '' };
    if (problem) {
      // never an invite that says "Hey ," : wait until Kai adds the name
      store.refresh(); store.setStatus(lead.url, 'error', { error: problem }); store.save();
      warn(`${lead.name || lead.url}: ${problem}, not invited`);
      continue;
    }
    const problems = note ? checkNote(note, cfg.noteMaxLength) : [];
    if (problems.length) { warn('note rejected', problems, note); continue; }

    let r;
    try {
      r = await ops.sendConnectionRequest(page, lead.url, note, { clients });
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
    if (r.info?.companyText && !cur.company) cur.company = r.info.companyText;

    switch (r.result) {
      case 'sent':
        store.setStatus(cur.url, 'invited', { invitedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() });
        store.recordAction('connects', cur.url, { note: r.noteSent ? note : '' });
        sent++; budget--;
        log(`invited ${cur.name || cur.url}`);
        break;
      case 'off-limits':
        store.setStatus(cur.url, 'skipped', { error: `works at your client ${r.client.name}`, offLimits: r.client.name, approved: false });
        log(`${cur.name || cur.url} works at your client ${r.client.name}: not invited`);
        break;
      case 'already-connected':
        // already connected: back to the 1st connections list, where a free message can go instead
        store.setStatus(cur.url, 'new', { degree: '1st', approved: false, notes: [cur.notes, 'already a 1st degree connection'].filter(Boolean).join(' | ') });
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
