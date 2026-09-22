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
import { draftRole, buildBoolean, buildSearchUrl, extractText, lookupGeo, slugFor, titleVariants, timezoneFor } from './role.js';
import { nextWorkingStart, withinWorkingHours } from './limits.js';
import { render } from './template.js';
import { rankLeads } from './rank.js';
import { searchLocations } from './actions/search.js';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.html');

const EDITABLE = ['mode', 'role', 'inmail', 'searchUrl', 'maxSearchPages', 'autoApprove', 'connectionNotes', 'followUps', 'dailyCaps', 'workingHours', 'pauseBetweenActionsSec', 'pauseBetweenCyclesMin'];

// Recruiter Lite lane: for people who have not accepted the connection. Sent by hand; the app writes the text.
export const DEFAULT_INMAIL = {
  afterDays: 7,
  subject: '{role}, {location}',
  body: "Hi {firstName},\n\nI'm running a search for a {role} with a growing digital asset business in {location}. {workType}.\n\nYour background looks close to what they're after, which is why I'm reaching out directly rather than posting it.\n\nWould you be open to hearing a bit more? A yes or no is fine either way.\n\nKai",
  followUpAfterDays: 4,
  followUp: "Hi {firstName}, just bringing this back up in case it slipped past you. If the {role} role isn't for you right now, no problem at all. Happy to keep you in mind for the next one. Kai",
};

// People due an InMail: invited, not accepted after `afterDays`, plus those whose one follow-up is due.
export function inmailList(store, cfg, now = new Date()) {
  const im = cfg?.inmail; if (!im) return [];
  const out = [];
  for (const l of store.leads({ campaign: cfg.name })) {
    if (l.status !== 'invited' || !l.invitedAt || l.preexisting) continue;
    const sent = l.inmail || {};
    if (sent.followUpAt) continue;                                           // both sent; lane over
    if (sent.sentAt) {
      if (now - new Date(sent.sentAt) >= (im.followUpAfterDays ?? 4) * 86400000)
        out.push({ url: l.url, name: l.name, headline: l.headline, kind: 'followUp', subject: render(im.subject, l, cfg.role), text: render(im.followUp, l, cfg.role) });
      continue;
    }
    if (now - new Date(l.invitedAt) >= (im.afterDays ?? 7) * 86400000)
      out.push({ url: l.url, name: l.name, headline: l.headline, kind: 'inmail', subject: render(im.subject, l, cfg.role), text: render(im.body, l, cfg.role) });
  }
  return out;
}

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

// The search the role would run right now, with the location ids we already know. Missing ones
// are looked up in the browser when Search is pressed.
export function rolePreview(cfg) {
  if (!cfg?.role?.boolean) return null;
  const geo = cfg.role.geo || {};
  const names = searchLocations(cfg.role);
  const ids = names.map(n => geo[n.toLowerCase()] || lookupGeo(n) || null);   // strict here: the browser gets first go at cities
  return { url: buildSearchUrl(cfg.role.boolean, ids.filter(Boolean)), locations: names.map((n, i) => ({ name: n, known: !!ids[i] })) };
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
    campaigns, campaign: c, cfg, cfgError, rolePreview: rolePreview(cfg),
    inmail: cfg ? inmailList(store, cfg) : [],
    hours: cfg?.workingHours ? { open: withinWorkingHours(cfg.workingHours), nextStart: nextWorkingStart(cfg.workingHours)?.toISOString() || null, timezone: cfg.workingHours.timezone } : { open: true, nextStart: null, timezone: null },
    leads: rankLeads(s.leads, cfg?.role).map(l => ({ ...l, queued: l.queue.length, sent: l.messages.length, lastMessage: l.messages[l.messages.length - 1]?.text || '' })),
    counts: s.counts, caps: s.caps, today: s.today, lastStop: s.lastStop,
    weeklyLimit: weeklyLimitActive(store),
    ownName: store.data.meta.ownName || null,
    loggedInAt: store.data.meta.loggedInAt || null,
    recruiterLoggedInAt: store.data.meta.recruiterLoggedInAt || null,
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
        if (b.action === 'record') { if (!/^https:\/\/www\.linkedin\.com\//.test(b.url || '')) return json(400, { error: 'record needs a linkedin.com URL' }); args.push(String(b.name || 'route').slice(0, 40), b.url); }
        if (b.action === 'probe') { if (!/^https:\/\/www\.linkedin\.com\//.test(b.url || '')) return json(400, { error: 'probe needs a linkedin.com URL' }); args.push(b.url); }
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
      if (u.pathname === '/api/role/draft') {
        // { text } or { file: { name, base64 } }
        let text = String(b.text || '');
        if (b.file?.base64) text = await extractText(b.file.name, Buffer.from(b.file.base64, 'base64'));
        if (!text.trim()) return json(400, { error: 'The spec is empty' });
        return json(200, { text, draft: draftRole(text) });
      }
      if (u.pathname === '/api/role/boolean') {
        const titles = b.titles?.length ? b.titles : titleVariants(b.title);
        return json(200, { titles, boolean: buildBoolean({ titles, domain: b.domain || [], skills: b.skills || [], exclude: b.exclude || [] }) });
      }
      if (u.pathname === '/api/role/save') {
        // { campaign?, role: { title, location, workType, candidateLocations, titles, domain, skills, exclude, boolean } }
        const role = b.role || {};
        if (!role.title) return json(400, { error: 'Give the role a title' });
        if (!role.boolean) return json(400, { error: 'The boolean search is empty' });
        let name = b.campaign || slugFor(role.title, role.location);
        const existing = readCampaignRaw(name);
        if (!b.campaign && existing && existing.role?.title !== role.title) name = `${name}-${Date.now().toString(36).slice(-4)}`;
        const keep = existing?.role?.geo || {};
        const base = existing ? {} : {
          mode: 'candidates',
          connectionNotes: ["Hey {firstName}, just wondering if you're on the market at the moment, as I have a new role, {role}, you might like. Let me know. Kai"],
          followUps: [
            { afterDays: 0, afterHours: 3, text: "Thanks for connecting {firstName}. The {role} role is in {location}, {workType}. Happy to send the brief over if you're curious. Worth a look?" },
            { afterDays: 4, text: "Hey {firstName}, just checking this didn't get buried. No pressure at all, but if the timing is wrong now I'm happy to keep you in mind for later." },
          ],
          inmail: DEFAULT_INMAIL,
          dailyCaps: { connects: 15, messages: 25, profileViews: 60 },
        };
        const tz = timezoneFor(role.location);
        if (tz && (!existing || existing.role?.location !== role.location)) base.workingHours = { ...(existing?.workingHours || { start: '09:30', end: '18:00', days: [1, 2, 3, 4, 5] }), timezone: tz };
        const cfg = saveCampaign(name, { ...base, mode: 'candidates', ...(existing ? {} : { searchUrl: '' }), role: { ...role, geo: keep } });
        return json(200, { ok: true, campaign: name, cfg, preview: rolePreview(cfg) });
      }
      if (u.pathname === '/api/clear') {
        // { campaign } wipes the uncontacted people for this role
        if (!b.campaign) return json(400, { error: 'no role chosen' });
        if (jobs.status().running) return json(400, { error: 'Stop the running job first' });
        const store = new Store();
        const n = store.clearUncontacted(b.campaign);
        store.recordAction('cleared', '-', { campaign: b.campaign, n });
        store.save();
        return json(200, { ok: true, n });
      }
      if (u.pathname === '/api/inmail-sent') {
        // { url, kind: 'inmail' | 'followUp' } Kai pressed "Sent" after pasting it into Recruiter Lite
        const store = new Store();
        const l = store.get(b.url);
        if (!l) return json(404, { error: 'no such lead' });
        l.inmail = l.inmail || {};
        const at = new Date().toISOString();
        if (b.kind === 'followUp') l.inmail.followUpAt = at; else l.inmail.sentAt = at;
        store.recordAction(b.kind === 'followUp' ? 'inmailFollowUp' : 'inmail', l.url, {});
        store.save();
        return json(200, { ok: true });
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
  const jobs = new Jobs();
  const server = createApp({ jobs });
  // Closing the Terminal window (or Ctrl+C) stops the running job and its Chrome too.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { jobs.killAll(); process.exit(0); });
  process.on('exit', () => jobs.killAll());
  server.listen(port, '127.0.0.1', () => log(`Sourcer is open at http://localhost:${port}`));
  return server;
}
