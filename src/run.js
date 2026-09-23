import { openBrowser, closeBrowser, isLoggedIn, CheckpointError, NotLoggedInError } from './browser.js';
import { Store } from './store.js';
import { withinWorkingHours, sleep, pauseFor, randomBetween } from './limits.js';
import { stopRequested } from './stop.js';
import { loadCampaign, listCampaigns } from './config.js';
import { runRecruiterSearch } from './actions/recruiter.js';
import { takeRequests, pending } from './requests.js';
import { runConnect } from './actions/connect.js';
import { sweepAcceptances, runMessages, sweepReplies } from './actions/followup.js';
import { runInMails } from './actions/inmail.js';
import { log, warn } from './log.js';
import { notify } from './notify.js';

// One cycle: check acceptances, send due messages, look for replies, then send new connection requests.
// A slow page or a busy file skips that step for this cycle; only a security check or being
// logged out stops the run.
export async function cycle(page, store, cfg) {
  const steps = [['acceptances', sweepAcceptances], ['messages', runMessages], ['replies', sweepReplies], ['connect', runConnect], ['inmail', runInMails]];
  for (const [what, fn] of steps) {
    if (stopRequested()) return;
    try { await fn(page, store, cfg); }
    catch (e) {
      if (e instanceof CheckpointError || e instanceof NotLoggedInError) throw e;
      // Chrome was closed: nothing can be sent, so end the run instead of looping on errors
      if (/(Target|page|context|browser)[^\n]*(closed|crashed)/i.test(e.message)) throw new Error('Chrome was closed, so outreach stopped. Press Start outreach to carry on.');
      warn(`${what} step failed, trying again next cycle:`, e.message);
    }
  }
}

// A Search pressed while a run is going happens in a second tab of the SAME Chrome, straight away.
// One signed-in browser, more than one tab: that is how a person works, and LinkedIn sees one device.
function watchForSearches(context, store, { active }) {
  const timer = setInterval(async () => {
    if (active.busy || stopRequested()) return;
    const all = pending();
    const name = Object.keys(all).find(n => (all[n] || []).includes('search'));
    if (!name) return;
    takeRequests(name);
    active.busy = true;
    let tab = null;
    try {
      const c = loadCampaign(name);
      log(`search for "${name}" in a second tab`);
      tab = await context.newPage();
      await runRecruiterSearch(tab, store, c);
    } catch (e) {
      warn(`search for "${name}" failed:`, e.message);
    } finally {
      if (tab) await tab.close().catch(() => {});
      active.busy = false;
    }
  }, 15000);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function runCampaign(cfg, { once = false, headless = false } = {}) {
  const store = new Store();
  let stopWatching = null;
  // Stop and update restarts arrive as SIGINT: finish the current person, then close Chrome ourselves
  const { context, page } = await openBrowser({ headless, handleSIGINT: false });
  try {
    if (!(await isLoggedIn(page))) throw new NotLoggedInError('Not logged in. Run: npm run login');
    const searchTab = { busy: false };
    stopWatching = once ? null : watchForSearches(context, store, { active: searchTab });
    log(`campaign "${cfg.name}" (${cfg.mode}) caps`, cfg.dailyCaps, 'hours', cfg.workingHours || 'any');
    let waitingLogged = false;
    do {
      if (stopRequested()) { log('stopped'); break; }
      // One browser, every role: each pass goes through all the roles that are inside their hours.
      // Kai pressing Search while this is running leaves a request, which is picked up here.
      const names = once ? [cfg.name] : [cfg.name, ...listCampaigns().filter(n => n !== cfg.name)];
      let worked = false;
      for (const name of names) {
        if (stopRequested()) break;
        let c;
        try { c = loadCampaign(name); } catch (e) { warn(`skipping "${name}": ${e.message}`); continue; }
        if (name === cfg.name) cfg = c;                       // settings saved in the app apply from here
        const asked = takeRequests(name);
        if (!withinWorkingHours(c.workingHours) && !asked.length) continue;
        worked = true;
        for (const req of asked) {
          if (req !== 'search') continue;
          try { log(`search asked for "${name}"`); await runRecruiterSearch(page, store, c); }
          catch (e) {
            if (e instanceof CheckpointError || e instanceof NotLoggedInError) throw e;
            warn(`search for "${name}" failed:`, e.message);
          }
        }
        if (!withinWorkingHours(c.workingHours)) continue;
        if (names.length > 1) log(`role: ${name}`);
        await cycle(page, store, c);
      }
      if (!worked) {
        if (once) { log('outside working hours, nothing sent'); break; }
        if (!waitingLogged) { log('outside working hours, waiting'); waitingLogged = true; }
        await pauseFor(60 * 1000);
        continue;
      }
      waitingLogged = false;
      if (once || stopRequested()) break;
      const mins = randomBetween(cfg.pauseBetweenCyclesMin[0], cfg.pauseBetweenCyclesMin[1]);
      log(`cycle done, next in ${mins.toFixed(0)} min`);
      await pauseFor(mins * 60 * 1000);
    } while (true);
  } catch (e) {
    if (e instanceof CheckpointError || e instanceof NotLoggedInError) {
      warn(e.message);
      notify('Sourcer stopped', e.message);
      store.recordAction('stopped', '-', { reason: e.message });
      store.save();
      if (e instanceof CheckpointError) {
        log('Leaving the browser open for 10 minutes so you can complete the check.');
        await sleep(10 * 60 * 1000);
      }
    } else {
      // anything else that ends the run is written down and shown, never lost
      warn('outreach stopped:', e.message);
      notify('Sourcer stopped', e.message);
      store.refresh();
      store.recordAction('stopped', '-', { reason: e.message });
      store.save();
      process.exitCode = 1;
    }
  } finally {
    if (stopWatching) stopWatching();
    await closeBrowser(context);
  }
}
