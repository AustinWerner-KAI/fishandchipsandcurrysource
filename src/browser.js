import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, PROFILE_DIR, SCREENSHOT_DIR, ensureDirs } from './paths.js';
import { SEL, firstVisible, anyPresent } from './selectors.js';
import { log, warn } from './log.js';
import { sleep, randomBetween } from './limits.js';

export class CheckpointError extends Error {}
export class NotLoggedInError extends Error {}

// Uses the Mac's own timezone, locale and window size so the browser looks like the same person
// who logs in by hand. SOURCER_CHROME can point at an installed Chrome instead of Playwright's Chromium.
export async function openBrowser({ headless = false } = {}) {
  ensureDirs();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    ...(process.env.SOURCER_CHROME ? { executablePath: process.env.SOURCER_CHROME } : {}),
    viewport: headless ? { width: 1360, height: 860 } : null,
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1360,900'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  await restoreSession(context);
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(20000);
  return { context, page };
}

// LinkedIn's login cookie is li_at. Chromium writes cookies to its profile on a timer, so a browser
// closed right after login can forget it. We keep our own copy in ~/.sourcer/session.json and put
// it back into the browser on every start.
export const SESSION_FILE = path.join(HOME, 'session.json');

export async function hasLoginCookie(context) {
  const cookies = await context.cookies('https://www.linkedin.com').catch(() => []);
  return cookies.some(c => c.name === 'li_at' && c.value);
}

export async function saveSession(context) {
  try {
    const { cookies } = await context.storageState();
    const li = cookies.filter(c => /linkedin\.com$/.test(c.domain));
    if (!li.some(c => c.name === 'li_at')) return false;
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ savedAt: new Date().toISOString(), cookies: li }), { mode: 0o600 });
    return true;
  } catch (e) {
    warn('could not save the LinkedIn session', e.message);
    return false;
  }
}

export async function restoreSession(context) {
  try {
    if (!fs.existsSync(SESSION_FILE)) return false;
    if (await hasLoginCookie(context)) return true;        // the profile kept it; nothing to do
    const { cookies } = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const now = Date.now() / 1000;
    const live = cookies.filter(c => !c.expires || c.expires < 0 || c.expires > now);
    if (!live.some(c => c.name === 'li_at')) return false;
    await context.addCookies(live);
    log('LinkedIn session restored from session.json');
    return true;
  } catch (e) {
    warn('could not restore the LinkedIn session', e.message);
    return false;
  }
}

// Save the session (cookies get refreshed while browsing) and close.
export async function closeBrowser(context) {
  await saveSession(context).catch(() => {});
  await context.close().catch(() => {});
}

export async function goto(page, url, { waitFor = 'domcontentloaded' } = {}) {
  await page.goto(url, { waitUntil: waitFor });
  await sleep(randomBetween(1200, 2600));
  await guard(page);
}

// Stop hard if LinkedIn throws a security checkpoint or logs us out. Never try to click through it.
export async function guard(page) {
  const url = page.url();
  if (/\/checkpoint\/lg\/login|\/uas\/login/i.test(url)) throw new NotLoggedInError('Not logged in. Run: npm run login');
  if (/\/checkpoint\/|\/challenge\/|security-verification/i.test(url)) {
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
    if (await anyPresent(page, SEL.loggedInMarker, 4000)) return true;
    // LinkedIn changes its nav markup now and then; the login cookie plus not being bounced to /login is enough
    if (await hasLoginCookie(page.context())) { log('logged in (nav selector not found, cookie present)'); return true; }
    await snap(page, 'not-logged-in');
    return false;
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
