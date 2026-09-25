import { openBrowser, closeBrowser, isLoggedIn, ensureWide, CheckpointError, NotLoggedInError } from './browser.js';
import { Store } from './store.js';
import { withinWorkingHours, sleep, pauseFor, randomBetween } from './limits.js';
import { stopRequested, stopFlag } from './stop.js';
import { loadCampaign, listCampaigns } from './config.js';
import { searchAndSweep } from './actions/search.js';
import { takeRequests, pending } from './requests.js';
import { runConnect } from './actions/connect.js';
import { sweepAcceptances, runMessages, sweepReplies } from './actions/followup.js';
import { runInMails } from './actions/inmail.js';
import { runCompanyLookups } from './actions/company.js';
import { log, warn } from './log.js';
import { notify } from './notify.js';

// One cycle: check acceptances, send due messages, look for replies, learn about new employers,
// then send new connection requests and InMails.
// A slow page or a busy file skips that step for this cycle; only a security check or being
// logged out stops the run.
export async function cycle(page, store, cfg) {
  const steps = [['acceptances', sweepAcceptances], ['messages', runMessages], ['replies', sweepReplies], ['companies', runCompanyLookups], ['connect', runConnect], ['inmail', runInMails]];
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

// A Search pressed during a run shares the day's profile views with the invites, so its public-source
// lookups are capped well below the 8 a standalone Search takes.
const IN_RUN_LOOKUPS = 3;

// A Search pressed while a run is going happens in a second tab of the SAME Chrome, straight away.
// One signed-in browser, more than one tab: that is how a person works, and LinkedIn sees one device.
function watchForSearches(context, { active, onFatal }) {
  const timer = setInterval(async () => {
    if (active.busy || stopRequested()) return;
    const all = pending();
    const name = Object.keys(all).find(n => (all[n] || []).includes('search'));
    if (!name) return;
    takeRequests(name);
    // the main tab is already searching this role: a second press is the same search, so drop it
    if (active.searching.has(name)) { log(`search for "${name}" is already running`); return; }
    active.busy = true;
    active.searching.add(name);
    let tab = null, keepTab = false;
    try {
      const c = loadCampaign(name);
      log(`search for "${name}" in a second tab`);
      tab = await context.newPage();
      await ensureWide(tab);            // a new tab can open narrow, and LinkedIn then hides its controls
      // Its own Store, never the run's. Both merge their changes into db.json when they save, but
      // sharing one would let this tab's reload throw away a reply the other tab had just marked
      // and not yet saved, and Sourcer would then message somebody who has already answered.
      // Inside a live run the sweep shares the day's 60 profile views with invites, so it takes a
      // small bite (3, not 8) and leaves the rest for outreach. The backlog keeps for the next Search.
      await searchAndSweep(tab, new Store(), c, { maxLookups: IN_RUN_LOOKUPS });
    } catch (e) {
      if (e instanceof CheckpointError) {
        // A security check is the whole account's problem: no more tabs, the run stops sending,
        // and this tab stays open because it is the one showing the check Kai has to complete.
        clearInterval(timer); keepTab = true; onFatal(e); return;
      }
      if (e instanceof NotLoggedInError) {
        // Usually Recruiter asking for its own sign-in again, while LinkedIn itself is fine. Outreach
        // carries on; if LinkedIn really is logged out, the main tab finds that on its next page.
        warn(`search for "${name}" needs you signed in again. Press Log in to Recruiter, then Search.`);
        notify('Sourcer search stopped', 'Recruiter wants you to sign in again. Press Log in to Recruiter, then Search. Outreach is still running.');
        return;
      }
      warn(`search for "${name}" failed:`, e.message);
    } finally {
      if (tab && !keepTab) await tab.close().catch(() => {});
      active.busy = false;
      active.searching.delete(name);
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
    const searchTab = { busy: false, searching: new Set() };
    // Raised on the second tab, dealt with by the loop below: a security check means nothing more
    // should be sent from either tab.
    let fatal = null;
    // It also raises the stop flag, so the main tab stops between people instead of finishing the cycle.
    stopWatching = once ? null : watchForSearches(context, { active: searchTab, onFatal: e => { fatal = fatal || e; stopFlag.on = true; } });
    log(`campaign "${cfg.name}" (${cfg.mode}) caps`, cfg.dailyCaps, 'hours', cfg.workingHours || 'any');
    let waitingLogged = false;
    do {
      if (fatal) throw fatal;
      if (stopRequested()) { log('stopped'); break; }
      // Each run is scoped to the selected role; other saved roles are never approached.
      // Kai pressing Search while this is running leaves a request, which is picked up here.
      const names = [cfg.name]; // Consent applies only to the selected role.
      let worked = false;
      for (const name of names) {
        if (fatal) throw fatal;
        if (stopRequested()) break;
        let c;
        try { c = loadCampaign(name); } catch (e) { warn(`skipping "${name}": ${e.message}`); continue; }
        if (name === cfg.name) cfg = c;                       // settings saved in the app apply from here
        const asked = takeRequests(name);
        if (!withinWorkingHours(c.workingHours) && !asked.length) continue;
        worked = true;
        for (const req of asked) {
          if (req !== 'search') continue;
          if (searchTab.searching.has(name)) { log(`search for "${name}" is already running in the second tab`); continue; }
          searchTab.searching.add(name);
          try { log(`search asked for "${name}"`); await searchAndSweep(page, store, c, { maxLookups: IN_RUN_LOOKUPS }); }
          catch (e) {
            if (e instanceof CheckpointError || e instanceof NotLoggedInError) throw e;
            warn(`search for "${name}" failed:`, e.message);
          }
          finally { searchTab.searching.delete(name); }
        }
        if (!withinWorkingHours(c.workingHours)) continue;
        if (names.length > 1) log(`role: ${name}`);
        await cycle(page, store, c);
      }
      if (!worked) {
        if (once) { log('outside working hours, nothing sent'); break; }
        if (!waitingLogged) { log('outside working hours, waiting'); waitingLogged = true; }
        await pauseFor(60 * 1000, () => fatal);
        continue;
      }
      waitingLogged = false;
      if (once || stopRequested()) break;
      const mins = randomBetween(cfg.pauseBetweenCyclesMin[0], cfg.pauseBetweenCyclesMin[1]);
      log(`cycle done, next in ${mins.toFixed(0)} min`);
      await pauseFor(mins * 60 * 1000, () => fatal);
    } while (true);
    // The loop can also end on Stop or after one pass; a security check raised on the second tab
    // in the meantime must still be reported as one, not as a quiet stop.
    if (fatal) throw fatal;
  } catch (e) {
    if (stopWatching) { stopWatching(); stopWatching = null; }
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
