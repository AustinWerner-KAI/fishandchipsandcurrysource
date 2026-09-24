#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { exec } from 'node:child_process';
import { Store } from './store.js';
import { loadCampaign, listCampaigns } from './config.js';
import { openBrowser, closeBrowser, isLoggedIn, hasLoginCookie, saveSession, passContractChooser } from './browser.js';
import { SEL } from './selectors.js';
import { runSearch } from './actions/search.js';
import { importLeads, exportCsv, approveLeads, queueMessages } from './actions/import.js';
import { runConnect } from './actions/connect.js';
import { runMessages, sweepAcceptances, sweepReplies } from './actions/followup.js';
import { runCampaign } from './run.js';
import { startDashboard, summarise } from './dashboard.js';
import { startApp } from './app.js';
import { CAMPAIGN_DIR, HOME } from './paths.js';
import { log, warn } from './log.js';

const [, , cmd, ...args] = process.argv;
const flag = name => args.includes(`--${name}`);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const VALUE_FLAGS = ['pages', 'max', 'port', 'status', 'location', 'since'];
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(args[i - 1].replace(/^--/, ''))));

const HELP = `
Sourcer. LinkedIn sourcing and outreach that runs as you.

  npm run login                       open the browser, log in to LinkedIn by hand once
  npm run login-recruiter             same for Recruiter Lite (it has its own sign-in)
  npm run search <campaign> [url]     collect people from a LinkedIn people search into the campaign
  npm run import <campaign> <file>    add profile URLs from a .txt (one per line) or .csv (url,name,...)
  npm run export <campaign>           print the campaign as CSV (for scoring in Claude)
  npm run approve <campaign> <file|--all>   mark leads OK to contact
  npm run queue <campaign> <file.json>      queue per-person messages [{url,text,notBefore?,note?}]
  npm run connect <campaign>          send connection requests to approved leads (up to the daily cap)
  npm run followup <campaign>         check acceptances, send due messages, look for replies
  npm run run <campaign> [--once]     the whole loop, all day, inside working hours
  npm run app                         the web app at http://localhost:4747 (what the launcher opens)
  npm run dashboard                   read-only dashboard at http://localhost:4747
  npm run status [campaign]           quick counts in the terminal
  npm run menu                        simple menu (what the double-click launcher opens)
  npm run sources -- <subject...>     search the public sources (GitHub, EIPs, Stack Exchange, Sherlock, npm, crates)
  npm run sources -- --list           what each source gives, what it is licensed for, and what we never touch

Campaign files: campaigns/<name>.json (the app creates them; examples in campaigns/examples/). Data: ${HOME}
`;

async function withBrowser(fn, { requireLogin = true } = {}) {
  const store = new Store();
  const { context, page } = await openBrowser({ headless: flag('headless') });
  try {
    if (requireLogin && !(await isLoggedIn(page))) throw new Error('Not logged in. Run: npm run login');
    return await fn(page, store);
  } finally {
    await closeBrowser(context);
  }
}

function campaignArg(i = 0) {
  const name = positional[i] || listCampaigns()[0];
  return loadCampaign(name);
}

async function main() {
  switch (cmd) {
    case 'login':
      return login();
    case 'login-recruiter':
      return loginRecruiter();
    case 'search': {
      const cfg = campaignArg();
      const url = positional[1];
      return withBrowser(async (page, store) => {
        const added = await runSearch(page, store, cfg, { url, maxPages: opt('pages') && +opt('pages') });
        // The same press also sweeps the public sources, unless this was a one-off URL search.
        if (!url && cfg.role && !flag('no-sources')) {
          const { runSources } = await import('./actions/sources.js');
          try { await runSources(page, store, cfg); }
          catch (e) {
            if (e.name === 'CheckpointError' || e.name === 'NotLoggedInError') throw e;
            warn('sources: skipped after a problem, LinkedIn results are saved:', e.message.slice(0, 140));
          }
        }
        return added;
      });
    }
    case 'import': {
      const cfg = campaignArg();
      if (!positional[1]) throw new Error('import needs a file');
      return importLeads(new Store(), cfg, positional[1], { approve: flag('approve') });
    }
    case 'export': {
      const cfg = campaignArg();
      process.stdout.write(exportCsv(new Store(), cfg, { status: opt('status') }));
      return;
    }
    case 'approve': {
      const cfg = campaignArg();
      const what = flag('all') ? '--all' : positional[1];
      if (!what) throw new Error('approve needs a file of URLs or --all');
      return approveLeads(new Store(), cfg, what);
    }
    case 'queue': {
      const cfg = campaignArg();
      if (!positional[1]) throw new Error('queue needs a JSON file');
      return queueMessages(new Store(), cfg, positional[1]);
    }
    case 'connect': {
      const cfg = campaignArg();
      return withBrowser((page, store) => runConnect(page, store, cfg, { max: opt('max') && +opt('max') }));
    }
    case 'followup': {
      const cfg = campaignArg();
      return withBrowser(async (page, store) => {
        await sweepAcceptances(page, store, cfg);
        await runMessages(page, store, cfg);
        await sweepReplies(page, store, cfg);
      });
    }
    case 'run': {
      const cfg = campaignArg();
      // a polite stop: the person being contacted is finished first
      const { stopFlag } = await import('./stop.js');
      process.on('SIGINT', () => { if (stopFlag.on) process.exit(130); stopFlag.on = true; log('stopping after the current step'); });
      return runCampaign(cfg, { once: flag('once'), headless: flag('headless') });
    }
    case 'app': {
      const port = +(opt('port') || 4747);
      startApp({ port });
      if (!flag('no-open')) exec(`open http://localhost:${port}`);
      return new Promise(() => {});
    }
    case 'dashboard': {
      const port = +(opt('port') || 4747);
      startDashboard({ port });
      if (!flag('no-open')) exec(`open http://localhost:${port}`);
      return new Promise(() => {});
    }
    case 'status': {
      const store = new Store();
      const names = positional[0] ? [positional[0]] : listCampaigns();
      for (const n of names) {
        const s = summarise(store, n);
        console.log(`\n${n}: ${JSON.stringify(s.counts)}\n  today: ${JSON.stringify(s.today)}`);
      }
      return;
    }
    case 'probe': {
      // Opens a LinkedIn page in the logged-in browser and saves a screenshot, the page HTML and the
      // list of links to ~/.sourcer/probe/, so page structure can be studied without touching anything.
      const target = positional[0];
      if (!target) throw new Error('probe needs a URL');
      return withBrowser(async page => {
        const dir = path.join(HOME, 'probe'); fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        // "#sourcer-type=<text>" on the URL: type that into Recruiter's search box and press Return first
        const [base, frag] = target.split('#sourcer-type=');
        await page.goto(base, { waitUntil: 'domcontentloaded' });
        await passContractChooser(page);
        await new Promise(r => setTimeout(r, 4000));
        if (frag) {
          const box = page.locator(SEL.recruiterSearchBox.join(', ')).first();
          await box.click(); await new Promise(r => setTimeout(r, 600));
          await box.pressSequentially(decodeURIComponent(frag), { delay: 20 });
          await new Promise(r => setTimeout(r, 1200));
          await page.keyboard.press('Enter');
        }
        await new Promise(r => setTimeout(r, +(opt('wait') || 8000)));
        for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 600); await new Promise(r => setTimeout(r, 700)); }
        await page.screenshot({ path: path.join(dir, `${stamp}.png`), fullPage: true });
        fs.writeFileSync(path.join(dir, `${stamp}.html`), await page.content());
        const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.getAttribute('href'), text: (a.innerText || '').trim().slice(0, 80) })));
        fs.writeFileSync(path.join(dir, `${stamp}.links.json`), JSON.stringify({ url: page.url(), title: await page.title(), links }, null, 1));
        log('probe saved', path.join(dir, stamp + '.{png,html,links.json}'), 'final url', page.url());
      });
    }
    case 'record': {
      const { recordRoute } = await import('./record.js');
      return recordRoute(positional[0], positional[1] || 'https://www.linkedin.com/talent/home');
    }
    // Search every public source we are allowed to fetch, and say which ones must be read by hand.
    case 'sources': {
      const { searchPublic } = await import('./sources/search.js');
      const { manualOnly, rejected } = await import('./sources/registry.js');
      if (flag('list')) {
        const { automated } = await import('./sources/registry.js');
        console.log('\nFetched automatically:');
        for (const s of automated()) console.log(`  ${s.id.padEnd(15)} ${s.title}\n  ${' '.repeat(15)} ${s.licence}`);
        console.log('\nRead by hand, their terms forbid us fetching them:');
        for (const s of manualOnly()) console.log(`  ${s.id.padEnd(15)} ${s.title}\n  ${' '.repeat(15)} ${s.url}`);
        console.log('\nLooked at and rejected:');
        for (const s of rejected()) console.log(`  ${s.id.padEnd(15)} ${s.why}`);
        return;
      }
      const terms = positional;
      if (!terms.length) throw new Error('sources needs something to look for, such as: npm run sources -- solidity');
      const r = await searchPublic({ terms, location: opt('location') || '', since: opt('since') || null });
      for (const p of r.people.slice(0, +(opt('max') || 40))) {
        const where = Object.values(p.urls)[0] || '';
        console.log(`\n${p.score}  ${p.name || '(no name yet)'}${p.location ? `  ${p.location}` : ''}${p.company ? `  at ${p.company}` : ''}`);
        console.log(`    seen on: ${p.sources.join(', ')}${p.github ? `  github/${p.github}` : ''}${p.lastActiveAt ? `  last active ${String(p.lastActiveAt).slice(0, 10)}` : ''}`);
        for (const e of p.evidence.slice(0, 4)) console.log(`    ${e.label}: ${e.value}`);
        if (where) console.log(`    ${where}`);
      }
      if (r.problems.length) console.log(`\nCould not reach: ${r.problems.map(x => `${x.source} (${x.problem})`).join('; ')}`);
      console.log('\nRead these yourself, we are not allowed to fetch them:');
      for (const m of r.manual) console.log(`  ${m.title}  ${m.url || ''}`);
      return;
    }
    case 'menu':
      return menu();
    default:
      console.log(HELP);
  }
}

async function menu() {
  const rl = readline.createInterface({ input, output });
  let dash = null;
  const ask = q => rl.question(q);
  for (;;) {
    const campaigns = listCampaigns();
    console.log(`\nSourcer\n  campaigns: ${campaigns.join(', ') || '(none yet, set up a role in the app)'}\n`);
    console.log('  1  Log in to LinkedIn\n  2  Search and collect leads\n  3  Open dashboard\n  4  Run campaign (all day)\n  5  Run one pass now\n  6  Status\n  q  Quit\n');
    const a = (await ask('> ')).trim();
    if (a === 'q') { rl.close(); process.exit(0); }
    try {
      const pickCampaign = async () => {
        if (campaigns.length === 1) return loadCampaign(campaigns[0]);
        const n = await ask(`campaign (${campaigns.join(', ')}): `);
        return loadCampaign(n.trim());
      };
      if (a === '1') await login();
      else if (a === '2') { const cfg = await pickCampaign(); await withBrowser((p, s) => runSearch(p, s, cfg)); }
      else if (a === '3') { if (!dash) dash = startDashboard({}); exec('open http://localhost:4747'); console.log('Dashboard running while this window is open.'); }
      else if (a === '4') { const cfg = await pickCampaign(); rl.close(); return runCampaign(cfg); }
      else if (a === '5') { const cfg = await pickCampaign(); await runCampaign(cfg, { once: true }); }
      else if (a === '6') { const store = new Store(); for (const n of campaigns) console.log(n, summarise(store, n).counts); }
    } catch (e) {
      console.error('\n' + e.message + '\n');
    }
  }
  rl.close();
}

async function login() {
  const { context, page } = await openBrowser();
  await page.goto('https://www.linkedin.com/login');
  console.log('\nLog in to LinkedIn in the browser window. It closes on its own once you are in.\n');
  const deadline = Date.now() + 10 * 60 * 1000;
  try {
    // Wait for LinkedIn's login cookie and a page that is not the login flow. Never navigate the
    // window ourselves while the person is typing in it.
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const url = page.url();
      const inFlow = /\/login|\/checkpoint|\/uas\/|\/signup|\/authwall/.test(url);
      if (!inFlow && (await hasLoginCookie(context))) {
        await new Promise(r => setTimeout(r, 4000));       // let LinkedIn finish setting cookies
        const saved = await saveSession(context);
        log(saved ? 'logged in, session saved' : 'logged in, but the session could not be saved');
        const st = new Store(); st.data.meta.loggedInAt = new Date().toISOString(); st.save();
        return;
      }
    }
    console.log('Timed out waiting for login.');
  } finally {
    await context.close().catch(() => {});
  }
}

// Recruiter Lite (linkedin.com/talent) asks for its own sign-in even when LinkedIn is logged in.
// Same idea as login(): the person signs in by hand, we wait, then keep the cookies.
async function loginRecruiter() {
  const { context, page } = await openBrowser();
  await page.goto('https://www.linkedin.com/talent/');
  console.log('\nSign in to Recruiter in the browser window. It closes on its own once you are in.\n');
  const deadline = Date.now() + 10 * 60 * 1000;
  try {
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const url = page.url();
      if (/\/talent\//.test(url) && !/login|checkpoint|uas\//.test(url)) {
        await new Promise(r => setTimeout(r, 4000));
        const saved = await saveSession(context);
        log(saved ? 'Recruiter signed in, session saved' : 'Recruiter signed in, but the session could not be saved');
        const st = new Store(); st.data.meta.recruiterLoggedInAt = new Date().toISOString(); st.save();
        return;
      }
    }
    console.log('Timed out waiting for the Recruiter sign-in.');
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(e => { console.error('\n' + (e.stack || e.message)); warn('stopped with an error:', e.message); process.exit(1); });
