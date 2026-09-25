import { containsHiringCompany } from '../outreach.js';
// Sends an InMail from the candidate's Recruiter Lite profile: the same steps Kai showed on
// 22 Sep (Message button, subject, message, Send). Rehearsal mode fills everything in and stops
// before Send, so a new layout is caught before a candidate ever sees anything.
import { goto, guard, snap, saveDom, typeLikeHuman } from '../browser.js';
import { SEL, firstVisible } from '../selectors.js';
import { log, warn } from '../log.js';
import { sleep, randomBetween } from '../limits.js';

// "1/84 InMail Credits" on the composer: how many are left.
// The first of these selectors that exists inside `scope` (visible or not).
async function firstPresent(scope, candidates) {
  for (const sel of candidates) { const loc = scope.locator(sel).first(); if (await loc.count().catch(() => 0)) return loc; }
  return null;
}

export function creditsFromText(text) {
  const m = String(text || '').match(/(\d+)\s*\/\s*(\d+)\s*InMail/i);
  return m ? { cost: +m[1], left: +m[2] } : null;
}

export async function readComposerCredits(page) {
  for (const sel of SEL.recruiterCreditText) {
    const t = await page.locator(sel).first().innerText().catch(() => '');
    const c = creditsFromText(t);
    if (c) return c;
  }
  return null;
}

// Returns { sent, rehearsed, credits, reason? }
export async function sendRecruiterInMail(page, url, { subject, body, rehearse = true, role = {} }) {
  if (containsHiringCompany(subject, role) || containsHiringCompany(body, role)) return { sent: false, reason: 'Hiring company name is confidential' };
  if (!/\/talent\//.test(String(url))) return { sent: false, reason: 'not a Recruiter profile' };
  await goto(page, url);
  await guard(page);
  const msg = await firstVisible(page, SEL.recruiterMessageButton, 8000);
  if (!msg) { await snap(page, 'recruiter-no-message-button'); await saveDom(page, 'recruiter-no-message-button'); return { sent: false, reason: 'no Message button on the Recruiter profile' }; }
  await msg.click();
  await sleep(randomBetween(1200, 2200));
  const composer = await firstVisible(page, SEL.recruiterComposer, 8000);
  if (!composer) { await snap(page, 'recruiter-no-composer'); await saveDom(page, 'recruiter-no-composer'); return { sent: false, reason: 'the message box did not open' }; }

  // subject: the composer's own box, never the template search box
  const subj = await firstVisible(composer, SEL.recruiterComposerSubject, 3000)
    || composer.locator('input[type="text"]:not(.ts-common-typeahead__input):not(.artdeco-typeahead__input)').first();
  if (subject && await subj.count().catch(() => 1)) {
    await subj.click().catch(() => {});
    await subj.fill('').catch(() => {});
    await typeLikeHuman(subj, subject);
  }
  // an empty message box can measure as zero height, so fall back to "it is there" rather than "it is visible"
  const editor = await firstVisible(composer, SEL.recruiterComposerBody, 5000) || await firstPresent(composer, SEL.recruiterComposerBody);
  if (!editor) { await snap(page, 'recruiter-no-body'); await saveDom(page, 'recruiter-no-body'); return { sent: false, reason: 'the message box has no text area' }; }
  await editor.click();
  await typeLikeHuman(editor, body);
  await sleep(randomBetween(800, 1500));
  const credits = await readComposerCredits(page);

  // Send lives outside the message box itself, so look in the panel and then on the page
  const send = await firstVisible(composer, SEL.recruiterComposerSend, 2000) || await firstVisible(page, SEL.recruiterComposerSend, 4000);
  if (!send) { await snap(page, 'recruiter-no-send'); await saveDom(page, 'recruiter-no-send'); return { sent: false, credits, reason: 'no Send button' }; }

  if (rehearse) {
    const shot = await snap(page, 'inmail-rehearsal');
    log(`rehearsal: the InMail is filled in and NOT sent (${shot || 'screenshot failed'})`);
    await closeComposer(page, composer);
    return { sent: false, rehearsed: true, credits, shot };
  }
  for (let i = 0; i < 6 && (await send.isDisabled().catch(() => false)); i++) await sleep(500);
  await send.click();
  await sleep(randomBetween(1800, 3000));
  await guard(page);
  // proof: the composer is gone
  const still = await firstVisible(page, SEL.recruiterComposerSend, 2500);
  if (still) { await snap(page, 'inmail-still-open'); return { sent: false, credits, reason: 'Send did not go through' }; }
  return { sent: true, credits };
}

export async function closeComposer(page, composer) {
  const x = await firstVisible(composer || page, SEL.recruiterComposerClose, 1500);
  if (x) await x.click().catch(() => {});
  await sleep(400);
}

// The InMail lane: for approved people whose invitation has gone unanswered for the configured
// delay and whom Sourcer can still reach in Recruiter. The first one is always a rehearsal (filled
// in, not sent) so Kai can check it; after he approves, the rest go by themselves.
import { ACCOUNT_TZ, remaining, humanPauseMs, pauseFor, inmailCredits } from '../limits.js';
import { renderChecked } from '../template.js';
import { allClients, offLimits } from '../offlimits.js';
import { tooNewInRole, tooJunior, minExperienceFor, MIN_TENURE_MONTHS } from '../company.js';
import { learn, rankLearned } from '../learn.js';
import { cleanLead } from '../rank.js';
import { stopRequested } from '../stop.js';
import { notify } from '../notify.js';
import { isRecruiterUrl } from '../store.js';

export function firstInMailDue(lead, im, now = Date.now()) {
  const invited = new Date(lead?.invitedAt || '').getTime();
  const waitMs = (im?.afterDays ?? 7) * 86400000;
  return lead?.status === 'invited' && !lead.preexisting && Number.isFinite(invited) && now - invited >= waitMs && !lead.inmail?.sentAt;
}

export async function runInMails(page, store, cfg, { max, ops = { sendRecruiterInMail }, pause = true } = {}) {
  const im = cfg.inmail;
  if (!im || im.viaRecruiter === false) return { sent: 0 };
  store.load();
  const tz = ACCOUNT_TZ;
  const perDay = im.perDay ?? 10;
  const monthly = inmailCredits(store, im.monthlyCredits ?? 30, new Date(), tz);
  const balance = store.data.meta.inmailBalance;                       // read from Recruiter itself
  const todayCount = store.actionsSince(new Date(Date.now() - 86400000).toISOString(), 'inmail').length;
  let budget = Math.min(max ?? Infinity, perDay - todayCount, monthly.left, balance ?? Infinity);
  if (budget <= 0) { log(`inmail: none to send (today ${todayCount}/${perDay}, ${monthly.left} of the month's ${monthly.total} left${balance != null ? `, ${balance} credits in Recruiter` : ''})`); return { sent: 0 }; }

  const clients = allClients();
  const model = learn(store.leads({ campaign: cfg.name }), cfg.role, Date.now(), clients);
  const now = Date.now();
  const people = rankLearned(store.leads({ campaign: cfg.name, status: 'invited' }), cfg.role, model)
    .filter(l => (l.approved) && cleanLead(l).degree !== '1st' && !offLimits(l, clients) && firstInMailDue(l, im, now))
    .filter(l => !tooNewInRole(l, cfg.minTenureMonths ?? MIN_TENURE_MONTHS))
    .filter(l => !tooJunior(l, minExperienceFor(cfg)))
    .filter(l => isRecruiterUrl(l.url) || l.recruiterUrl)
    .sort((a, b) => (b.rank.score ?? 0) - (a.rank.score ?? 0));
  if (!people.length) { log('inmail: nobody waiting that Recruiter can reach'); return { sent: 0 }; }

  let sent = 0;
  for (const picked of people) {
    if (budget <= 0 || stopRequested()) break;
    if (remaining(store, cfg.dailyCaps, 'profileViews', new Date(), tz) < 1) { log('inmail: profile view cap reached'); break; }
    const lead = store.refresh(picked.url);
    if (!lead || !firstInMailDue(lead, im) || !(lead.approved)) continue;
    const subject = renderChecked(im.subject, lead, cfg.role);
    const body = renderChecked(im.body, lead, cfg.role);
    if (subject.problem || body.problem) { lead.error = subject.problem || body.problem; store.save(); continue; }

    const rehearse = !store.data.meta.inmailApprovedAt;
    const url = lead.recruiterUrl || lead.url;
    let r;
    try { r = await ops.sendRecruiterInMail(page, url, { subject: subject.text, body: body.text, rehearse, role: cfg.role || {} }); }
    catch (e) {
      if (e.name === 'CheckpointError' || e.name === 'NotLoggedInError') throw e;
      warn('inmail failed', url, e.message);
      r = { sent: false, reason: e.message.slice(0, 80) };
    }
    store.refresh();
    store.recordAction('profileViews', lead.url);
    if (r.credits?.left != null) store.data.meta.inmailBalance = r.credits.left;

    if (r.rehearsed) {
      store.data.meta.inmailRehearsal = { url: lead.url, name: lead.name, subject: subject.text, body: body.text, at: new Date().toISOString(), shot: (r.shot || '').split('/').pop() };
      store.save();
      notify('InMail ready to check', `${lead.name}: open Sourcer and approve the wording.`);
      log('inmail: rehearsal done, waiting for Kai to approve the wording');
      return { sent: 0, rehearsed: true };
    }
    if (!r.sent) {
      // try again on a later pass; only a third failure becomes a problem Kai has to look at
      warn(`inmail not sent to ${lead.name || url}: ${r.reason}`);
      const cur = store.get(lead.url) || lead;
      cur.inmailFails = (cur.inmailFails || 0) + 1;
      cur.lastTryError = `InMail: ${r.reason}`;
      if (cur.inmailFails >= 3) store.setStatus(lead.url, 'error', { error: `InMail not sent after 3 tries (${r.reason})` });
      store.save();
      if (pause) await pauseFor(humanPauseMs([20, 60]));
      continue;
    }
    store.setStatus(lead.url, 'messaged', { channel: 'inmail', inmail: { ...(lead.inmail || {}), sentAt: new Date().toISOString(), subject: subject.text } });
    store.recordAction('inmail', lead.url, { campaign: cfg.name });
    // on the store's own copy: `lead` was detached by the refresh above, so clearing it there
    // left the old failure sitting on the record for ever
    const saved = store.get(lead.url);
    if (saved) { saved.inmailFails = undefined; saved.lastTryError = undefined; }
    store.save();
    sent++; budget--;
    log(`InMail sent to ${lead.name || url}`);
    if (pause) await pauseFor(humanPauseMs(cfg.pauseBetweenActionsSec));
  }
  log(`inmail: ${sent} sent this pass`);
  return { sent };
}
