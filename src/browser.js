import { chromium } from 'playwright';
import path from 'node:path';
import { PROFILE_DIR, SCREENSHOT_DIR, ensureDirs } from './paths.js';
import { SEL, firstVisible, anyPresent } from './selectors.js';
import { log, warn } from './log.js';
import { sleep, randomBetween } from './limits.js';

export class CheckpointError extends Error {}
export class NotLoggedInError extends Error {}

export async function openBrowser({ headless = false, timezone = 'Asia/Dubai' } = {}) {
  ensureDirs();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    ...(process.env.SOURCER_CHROME ? { executablePath: process.env.SOURCER_CHROME } : {}),
    viewport: { width: 1360, height: 860 },
    locale: 'en-GB',
    timezoneId: timezone,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(20000);
  return { context, page };
}

export async function goto(page, url, { waitFor = 'domcontentloaded' } = {}) {
  await page.goto(url, { waitUntil: waitFor });
  await sleep(randomBetween(1200, 2600));
  await guard(page);
}

// Stop hard if LinkedIn throws a security checkpoint or logs us out. Never try to click through it.
export async function guard(page) {
  const url = page.url();
  if (/\/checkpoint\/|\/challenge\/|\/uas\/|security-verification/i.test(url)) {
    await snap(page, 'checkpoint');
    throw new CheckpointError(`LinkedIn is showing a security check at ${url}. Stopping. Open the browser, complete it by hand, then run again.`);
  }
  if (/\/login|\/authwall|\/signup/i.test(url) || (await anyPresent(page, SEL.loginForm, 500))) {
    throw new NotLoggedInError('Not logged in. Run: npm run login');
  }
}

export async function isLoggedIn(page) {
  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
    await sleep(1500);
    if (/\/login|\/authwall|\/checkpoint/i.test(page.url())) return false;
    return await anyPresent(page, SEL.loggedInMarker, 4000);
  } catch {
    return false;
  }
}

export async function snap(page, label) {
  try {
    ensureDirs();
    const file = path.join(SCREENSHOT_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.png`);
    await page.screenshot({ path: file, fullPage: false });
    log('screenshot', file);
    return file;
  } catch (e) {
    warn('screenshot failed', e.message);
    return null;
  }
}

// Scroll like a person: a few wheel moves with pauses, sometimes back up a bit.
export async function humanScroll(page, { steps = 4 } = {}) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, randomBetween(250, 700));
    await sleep(randomBetween(400, 1300));
    if (Math.random() < 0.2) {
      await page.mouse.wheel(0, -randomBetween(80, 250));
      await sleep(randomBetween(300, 800));
    }
  }
}

export async function typeLikeHuman(locator, text) {
  await locator.click();
  await sleep(randomBetween(200, 500));
  // type in short bursts; chunking keeps it quick but not instantaneous
  const chunks = text.match(/.{1,12}/gs) || [];
  for (const c of chunks) {
    await locator.pressSequentially(c, { delay: randomBetween(25, 80) });
    if (Math.random() < 0.15) await sleep(randomBetween(200, 600));
  }
}

export { firstVisible, anyPresent };
