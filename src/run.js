import { openBrowser, isLoggedIn, CheckpointError, NotLoggedInError } from './browser.js';
import { Store } from './store.js';
import { withinWorkingHours, sleep, randomBetween } from './limits.js';
import { runConnect } from './actions/connect.js';
import { sweepAcceptances, runMessages, sweepReplies } from './actions/followup.js';
import { log, warn } from './log.js';

// One cycle: check acceptances, send due messages, look for replies, then send new connection requests.
export async function cycle(page, store, cfg) {
  await sweepAcceptances(page, store, cfg);
  await runMessages(page, store, cfg);
  await sweepReplies(page, store, cfg);
  await runConnect(page, store, cfg);
}

export async function runCampaign(cfg, { once = false, headless = false } = {}) {
  const store = new Store();
  const { context, page } = await openBrowser({ headless, timezone: cfg.workingHours?.timezone });
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
    await context.close().catch(() => {});
  }
}
