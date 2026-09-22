import { openBrowser, closeBrowser, isLoggedIn, CheckpointError, NotLoggedInError } from './browser.js';
import { Store } from './store.js';
import { withinWorkingHours, sleep, randomBetween } from './limits.js';
import { runConnect } from './actions/connect.js';
import { sweepAcceptances, runMessages, sweepReplies } from './actions/followup.js';
import { log, warn } from './log.js';
import { notify } from './notify.js';

// One cycle: check acceptances, send due messages, look for replies, then send new connection requests.
// A slow page or a busy file skips that step for this cycle; only a security check or being
// logged out stops the run.
export async function cycle(page, store, cfg) {
  const steps = [['acceptances', sweepAcceptances], ['messages', runMessages], ['replies', sweepReplies], ['connect', runConnect]];
  for (const [what, fn] of steps) {
    try { await fn(page, store, cfg); }
    catch (e) {
      if (e instanceof CheckpointError || e instanceof NotLoggedInError) throw e;
      warn(`${what} step failed, trying again next cycle:`, e.message);
    }
  }
}

export async function runCampaign(cfg, { once = false, headless = false } = {}) {
  const store = new Store();
  const { context, page } = await openBrowser({ headless });
  try {
    if (!(await isLoggedIn(page))) throw new NotLoggedInError('Not logged in. Run: npm run login');
    log(`campaign "${cfg.name}" (${cfg.mode}) caps`, cfg.dailyCaps, 'hours', cfg.workingHours || 'any');
    do {
      if (!withinWorkingHours(cfg.workingHours)) {
        if (once) { log('outside working hours, nothing sent'); break; }
        log('outside working hours, waiting');
        await sleep(10 * 60 * 1000);
        continue;
      }
      await cycle(page, store, cfg);
      if (once) break;
      const mins = randomBetween(cfg.pauseBetweenCyclesMin[0], cfg.pauseBetweenCyclesMin[1]);
      log(`cycle done, next in ${mins.toFixed(0)} min`);
      await sleep(mins * 60 * 1000);
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
      throw e;
    }
  } finally {
    await closeBrowser(context);
  }
}
