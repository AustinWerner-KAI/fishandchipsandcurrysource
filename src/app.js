// The local web app: everything the terminal menu did, in a browser tab at http://localhost:4747
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, STATUSES } from './store.js';
import { listCampaigns, loadCampaign } from './config.js';
import { CAMPAIGN_DIR, HOME, SCREENSHOT_DIR } from './paths.js';
import { summarise } from './dashboard.js';
import { exportCsv, importLeads, queueMessages } from './actions/import.js';
import { weeklyLimitActive } from './actions/connect.js';
import { Jobs } from './jobs.js';
import { log } from './log.js';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.html');

const EDITABLE = ['mode', 'searchUrl', 'maxSearchPages', 'autoApprove', 'connectionNotes', 'followUps', 'dailyCaps', 'workingHours', 'pauseBetweenActionsSec', 'pauseBetweenCyclesMin'];

function readCampaignRaw(name) {
  const f = path.join(CAMPAIGN_DIR, `${name}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

export function saveCampaign(name, patch) {
  if (!/^[a-z0-9][a-z0-9-_]{0,40}$/i.test(name)) throw new Error('Campaign name: letters, numbers, dashes only');
  fs.mkdirSync(CAMPAIGN_DIR, { recursive: true });
  const f = path.join(CAMPAIGN_DIR, `${name}.json`);
  const before = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  const raw = before ? JSON.parse(before) : {};
  for (const k of EDITABLE) if (k in patch) raw[k] = patch[k];
  fs.writeFileSync(f, JSON.stringify(raw, null, 2));
  try {
    return loadCampaign(name);           // validates through the same path the runner uses
  } catch (e) {
    if (before === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, before);
    throw e;
  }
}

export function state(jobs, campaignName) {
  const store = new Store();
  const campaigns = listCampaigns();
  const c = campaignName && campaigns.includes(campaignName) ? campaignName : campaigns[0] || null;
  let cfg = null, cfgError = null;
  if (c) { try { cfg = loadCampaign(c); } catch (e) { cfgError = e.message; cfg = { name: c, ...(readCampaignRaw(c) || {}) }; } }
  const s = c ? summarise(store, c) : { leads: [], counts: {}, caps: null, today: {}, lastStop: null, weekly: null };
  const shots = fs.existsSync(SCREENSHOT_DIR) ? fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png')).sort().slice(-5).reverse() : [];
  return {
    campaigns, campaign: c, cfg, cfgError,
    leads: s.leads.map(l => ({ ...l, queued: l.queue.length, sent: l.messages.length, lastMessage: l.messages[l.messages.length - 1]?.text || '' })),
    counts: s.counts, caps: s.caps, today: s.today, lastStop: s.lastStop,
    weeklyLimit: weeklyLimitActive(store),
    ownName: store.data.meta.ownName || null,
    loggedInAt: store.data.meta.loggedInAt || null,
    job: jobs.status(),
    screenshots: shots,
    home: HOME,
    statuses: STATUSES,
  };
}

async function body(req) {
  let b = '';
  for await (const ch of req) b += ch;
  return b ? JSON.parse(b) : {};
}

export function createApp({ jobs = new Jobs() } = {}) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const c = u.searchParams.get('c') || undefined;
    try {
      if (req.method === 'GET' && u.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(UI, 'utf8'));
      }
      if (req.method === 'GET' && u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && u.pathname === '/api/state') return json(200, state(jobs, c));
      if (req.method === 'GET' && u.pathname === '/api/log') return json(200, { lines: jobs.since(+(u.searchParams.get('since') || 0)), job: jobs.status() });
      if (req.method === 'GET' && u.pathname === '/export.csv') {
        const store = new Store();
        res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${c || 'leads'}.csv"` });
        return res.end(exportCsv(store, { name: c }));
      }
      if (req.method === 'GET' && u.pathname.startsWith('/screenshots/')) {
        const f = path.join(SCREENSHOT_DIR, path.basename(u.pathname));
        if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(fs.readFileSync(f));
      }
      if (req.method !== 'POST') { res.writeHead(404); return res.end('not found'); }
      const b = await body(req);

      if (u.pathname === '/api/job') {
        if (b.action === 'stop') return json(200, jobs.stop());
        const args = [];
        if (b.action === 'search' && b.url) args.push(b.url);
        return json(200, jobs.start(b.action, { campaign: b.campaign, args }));
      }
      if (u.pathname === '/api/approve') {
        const store = new Store();
        let n = 0;
        for (const url of [].concat(b.urls || b.url || [])) {
          const l = store.get(url);
          if (l) { l.approved = !!b.approved; n++; }
        }
        store.save();
        return json(200, { ok: true, n });
      }
      if (u.pathname === '/api/status') {
        const store = new Store();
        const l = store.get(b.url);
        if (!l) return json(404, { error: 'no such lead' });
        if (!STATUSES.includes(b.status)) return json(400, { error: 'bad status' });
        store.setStatus(l.url, b.status, b.status === 'skipped' ? { error: 'skipped by hand' } : {});
        store.save();
        return json(200, { ok: true });
      }
      if (u.pathname === '/api/queue') {
        // items: [{ url, text, note?, notBefore?, resume? }]
        const tmp = path.join(HOME, `queue-${Date.now()}.json`);
        fs.writeFileSync(tmp, JSON.stringify(b.items || []));
        try { return json(200, { ok: true, n: queueMessages(new Store(), { name: b.campaign }, tmp) }); }
        finally { fs.rmSync(tmp, { force: true }); }
      }
      if (u.pathname === '/api/unqueue') {
        const store = new Store();
        const l = store.get(b.url);
        if (l) { l.queue.splice(b.index ?? 0, 1); store.save(); }
        return json(200, { ok: true });
      }
      if (u.pathname === '/api/import') {
        const tmp = path.join(HOME, `import-${Date.now()}.txt`);
        fs.writeFileSync(tmp, String(b.text || ''));
        try { return json(200, importLeads(new Store(), { name: b.campaign }, tmp, { approve: !!b.approve })); }
        finally { fs.rmSync(tmp, { force: true }); }
      }
      if (u.pathname === '/api/campaign') {
        const cfg = saveCampaign(b.name, b.config || {});
        return json(200, { ok: true, cfg });
      }
      if (u.pathname === '/api/note') {
        const store = new Store();
        const l = store.get(b.url);
        if (!l) return json(404, { error: 'no such lead' });
        l.notes = String(b.notes || '');
        store.save();
        return json(200, { ok: true });
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      json(400, { error: e.message });
    }
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') log('Sourcer is already open in another window. Close that one first, or just use it.');
    else log('app error', e.message);
  });
  return server;
}

export function startApp({ port = 4747 } = {}) {
  const server = createApp();
  server.listen(port, '127.0.0.1', () => log(`Sourcer is open at http://localhost:${port}`));
  return server;
}
