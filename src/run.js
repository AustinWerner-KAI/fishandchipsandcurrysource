import { openBrowser, closeBrowser, isLoggedIn, CheckpointError, NotLoggedInError } from './browser.js';
import { Store } from './store.js';
import { withinWorkingHours, sleep, pauseFor, randomBetween } from './limits.js';
import { stopRequested } from './stop.js';
import { loadCampaign } from './config.js';
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

export async function runCampaign(cfg, { once = false, headless = false } = {}) {
  const store = new Store();
  // Stop and update restarts arrive as SIGINT: finish the current person, then close Chrome ourselves
  const { context, page } = await openBrowser({ headless, handleSIGINT: false });
  try {
    if (!(await isLoggedIn(page))) throw new NotLoggedInError('Not logged in. Run: npm run login');
    log(`campaign "${cfg.name}" (${cfg.mode}) caps`, cfg.dailyCaps, 'hours', cfg.workingHours || 'any');
    let waitingLogged = false;
    do {
      if (stopRequested()) { log('stopped'); break; }
      // settings saved in the app (wording, caps, hours) apply from the next pass
      try { cfg = loadCampaign(cfg.name); } catch (e) { warn('settings could not be reloaded, keeping the previous ones:', e.message); }
      if (!withinWorkingHours(cfg.workingHours)) {
        if (once) { log('outside working hours, nothing sent'); break; }
        if (!waitingLogged) { log('outside working hours, waiting'); waitingLogged = true; }
        await pauseFor(60 * 1000);
        continue;
      }
      waitingLogged = false;
      await cycle(page, store, cfg);
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
    await closeBrowser(context);
  }
}
