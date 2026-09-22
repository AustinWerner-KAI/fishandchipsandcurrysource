#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { exec } from 'node:child_process';
import { Store } from './store.js';
import { loadCampaign, listCampaigns } from './config.js';
import { openBrowser, isLoggedIn } from './browser.js';
import { runSearch } from './actions/search.js';
import { importLeads, exportCsv, approveLeads, queueMessages } from './actions/import.js';
import { runConnect } from './actions/connect.js';
import { runMessages, sweepAcceptances, sweepReplies } from './actions/followup.js';
import { runCampaign } from './run.js';
import { startDashboard, summarise } from './dashboard.js';
import { CAMPAIGN_DIR, HOME } from './paths.js';
import { log } from './log.js';

const [, , cmd, ...args] = process.argv;
const flag = name => args.includes(`--${name}`);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const VALUE_FLAGS = ['pages', 'max', 'port', 'status'];
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.includes(args[i - 1].replace(/^--/, ''))));

const HELP = `
Sourcer. LinkedIn sourcing and outreach that runs as you.

  npm run login                       open the browser, log in to LinkedIn by hand once
  npm run search <campaign> [url]     collect people from a LinkedIn people search into the campaign
  npm run import <campaign> <file>    add profile URLs from a .txt (one per line) or .csv (url,name,...)
  npm run export <campaign>           print the campaign as CSV (for scoring in Claude)
  npm run approve <campaign> <file|--all>   mark leads OK to contact
  npm run queue <campaign> <file.json>      queue per-person messages [{url,text,notBefore?,note?}]
  npm run connect <campaign>          send connection requests to approved leads (up to the daily cap)
  npm run followup <campaign>         check acceptances, send due messages, look for replies
  npm run run <campaign> [--once]     the whole loop, all day, inside working hours
  npm run dashboard                   http://localhost:4747
  npm run status [campaign]           quick counts in the terminal
  npm run menu                        simple menu (what the double-click launcher opens)

Campaign files: campaigns/<name>.json (see campaigns/example.json). Data: ${HOME}
`;

async function withBrowser(fn, { requireLogin = true } = {}) {
  const store = new Store();
  const { context, page } = await openBrowser({ headless: flag('headless') });
  try {
    if (requireLogin && !(await isLoggedIn(page))) throw new Error('Not logged in. Run: npm run login');
    return await fn(page, store);
  } finally {
    await context.close().catch(() => {});
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
    case 'search': {
      const cfg = campaignArg();
      const url = positional[1];
      return withBrowser((page, store) => runSearch(page, store, cfg, { url, maxPages: opt('pages') && +opt('pages') }));
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
      return runCampaign(cfg, { once: flag('once'), headless: flag('headless') });
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
    case 'menu':
      return menu();
    default:
      console.log(HELP);
  }
}

async function menu() {
  const rl = readline.createInterface({ input, output });
  const ask = q => rl.question(q);
  for (;;) {
    const campaigns = listCampaigns();
    console.log(`\nSourcer\n  campaigns: ${campaigns.join(', ') || '(none yet, copy campaigns/example.json)'}\n`);
    console.log('  1  Log in to LinkedIn\n  2  Search and collect leads\n  3  Open dashboard\n  4  Run campaign (all day)\n  5  Run one pass now\n  6  Status\n  q  Quit\n');
    const a = (await ask('> ')).trim();
    if (a === 'q') break;
    try {
      const pickCampaign = async () => {
        if (campaigns.length === 1) return loadCampaign(campaigns[0]);
        const n = await ask(`campaign (${campaigns.join(', ')}): `);
        return loadCampaign(n.trim());
      };
      if (a === '1') await login();
      else if (a === '2') { const cfg = await pickCampaign(); await withBrowser((p, s) => runSearch(p, s, cfg)); }
      else if (a === '3') { startDashboard({}); exec('open http://localhost:4747'); console.log('Dashboard running. Leave this window open. Press q to stop.'); }
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
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      const url = page.url();
      if (/\/feed|\/mynetwork|\/in\//.test(url) || (!/\/login|\/checkpoint|\/uas\/|\/signup/.test(url) && await isLoggedIn(page))) {
        log('logged in, session saved');
        return;
      }
    }
    console.log('Timed out waiting for login.');
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch(e => { console.error('\n' + (e.stack || e.message)); process.exit(1); });
