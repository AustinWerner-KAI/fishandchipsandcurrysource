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
import { ACCOUNT_TZ, nextWorkingStart, withinWorkingHours, inmailCredits, weekCount, DEFAULT_WEEKLY_CONNECTS } from './limits.js';
import { tenureLabel, tenureOk, sizeWord, tooJunior, isJunior, minExperienceFor, overLevelled, levelFromTitle, SENIORITY, MIN_TENURE_MONTHS } from './company.js';
import { scoreLead } from './rank.js';
import { render, renderChecked, nameFor } from './template.js';
import { rankLeads, cleanLead } from './rank.js';
import { learn, rankLearned, noteStats } from './learn.js';
import { allClients, offLimits } from './offlimits.js';
import { askFor, pending } from './requests.js';
import { searchLocations } from './actions/search.js';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.html');

const EDITABLE = ['mode', 'role', 'firstDegree', 'inmail', 'searchUrl', 'maxSearchPages', 'autoApprove', 'minTenureMonths', 'minExperienceMonths', 'seniority', 'connectionNotes', 'followUps', 'dailyCaps', 'workingHours', 'pauseBetweenActionsSec', 'pauseBetweenCyclesMin'];

// Recruiter Lite lane: for people who have not accepted the connection. Sent by hand; the app writes the text.
export const DEFAULT_INMAIL = {
  afterDays: 7,
  monthlyCredits: 30,
  perDay: 10,
  viaRecruiter: true,
  subject: '{role}, {location}',
  body: "Hi {firstName},\n\nI'm running a search for a {role} with a growing digital asset business in {location}. {workType}.\n\nYour background looks close to what they're after, which is why I'm reaching out directly rather than posting it.\n\nWould you be open to hearing a bit more? A yes or no is fine either way.\n\nKai",
  followUpAfterDays: 4,
  followUp: "Hi {firstName}, just bringing this back up in case it slipped past you. If the {role} role isn't for you right now, no problem at all. Happy to keep you in mind for the next one. Kai",
};

// People due an InMail: invited, not accepted after `afterDays`, plus those whose one follow-up is due.
export function inmailList(store, cfg, now = new Date(), clients = allClients()) {
  const im = cfg?.inmail; if (!im) return [];
  const out = [], firsts = [];
  for (const l of store.leads({ campaign: cfg.name })) {
    if (l.status !== 'invited' || !l.invitedAt || l.preexisting) continue;
    if (offLimits(l, clients)) continue;                                   // works at a client
    const sent = l.inmail || {};
    if (sent.followUpAt || sent.replied) continue;                          // lane over
    const subj = renderChecked(im.subject, l, cfg.role);
    const item = { url: l.url, name: l.name, headline: l.headline, subject: subj.text, problem: subj.problem, score: scoreLead(l, cfg.role).score ?? 0 };
    if (sent.sentAt) {
      if (now - new Date(sent.sentAt) >= (im.followUpAfterDays ?? 4) * 86400000) { const r = renderChecked(im.followUp, l, cfg.role); out.push({ ...item, kind: 'followUp', text: r.text, problem: item.problem || r.problem }); }
      continue;
    }
    if (now - new Date(l.invitedAt) >= (im.afterDays ?? 7) * 86400000) { const r = renderChecked(im.body, l, cfg.role); firsts.push({ ...item, kind: 'inmail', text: r.text, problem: item.problem || r.problem }); }
  }
  // A new InMail costs a credit: offer only as many as are left this month, best matches first.
  const credits = inmailCredits(store, im.monthlyCredits ?? 30, now, ACCOUNT_TZ);
  firsts.sort((a, b) => b.score - a.score);
  return [...out, ...firsts.slice(0, credits.left)];
}

// The 1st connections message as the best-matched person on that list would get it.
function firstPreview(store, cfg) {
  if (!cfg?.firstDegree?.message) return null;
  const clients = allClients();
  const top = rankLeads(store.leads({ campaign: cfg.name, status: 'new' }), cfg.role).filter(l => l.degree === '1st' && !offLimits(l, clients))
    .sort((a, b) => (b.rank.score ?? 0) - (a.rank.score ?? 0))[0];
  return top ? { name: top.name, ...renderChecked(cfg.firstDegree.message, top, cfg.role) } : null;
}

// The latest invite for this role: who and when, for the status line.
function lastInvite(store, leads) {
  const urls = new Set(leads.map(l => l.url));
  for (let i = store.data.actions.length - 1; i >= 0; i--) {
    const a = store.data.actions[i];
    if (a.type === 'connects' && urls.has(a.url)) { const l = store.get(a.url); return { name: l?.name || '', at: a.at }; }
  }
  return null;
}

function readCampaignRaw(name) {
  if (!NAME_RE.test(String(name || ''))) return null;
  const f = path.join(CAMPAIGN_DIR, `${name}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

export function saveCampaign(name, patch) {
  if (!NAME_RE.test(name)) throw new Error('Campaign name: letters, numbers, dashes only');
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
  const clients = allClients();
  const s = c ? summarise(store, c) : { leads: [], counts: {}, caps: null, today: {}, lastStop: null, weekly: null };
  const shots = fs.existsSync(SCREENSHOT_DIR) ? fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png')).sort().slice(-5).reverse() : [];
  const roles = campaigns.map(name => {
    try { const r = readCampaignRaw(name)?.role; return { name, title: r?.title || name, location: r?.location || '' }; }
    catch { return { name, title: name, location: '' }; }
  });
  const model = cfg?.role ? learn(s.leads, cfg.role, Date.now(), clients) : null;
  const minTenure = cfg?.minTenureMonths ?? MIN_TENURE_MONTHS;
  const minExperience = cfg ? minExperienceFor(cfg) : 36;
  const level = cfg?.seniority || levelFromTitle(cfg?.role?.title);
  return {
    campaigns, roles, campaign: c, cfg, cfgError, rolePreview: rolePreview(cfg),
    inmail: cfg ? inmailList(store, cfg) : [],
    firstDegreePreview: firstPreview(store, cfg),

    inmailCredits: cfg?.inmail ? inmailCredits(store, cfg.inmail.monthlyCredits ?? 30, new Date(), ACCOUNT_TZ) : null,
    week: { connects: weekCount(store, 'connects'), cap: cfg?.dailyCaps?.weeklyConnects ?? DEFAULT_WEEKLY_CONNECTS },
    hours: cfg?.workingHours ? { open: withinWorkingHours(cfg.workingHours), nextStart: nextWorkingStart(cfg.workingHours)?.toISOString() || null, timezone: cfg.workingHours.timezone } : { open: true, nextStart: null, timezone: null },
    client: cfg?.role?.client || null,
    health: store.data.meta.health || null,
    queued: c ? pending(c) : [],
    inmailRehearsal: store.data.meta.inmailApprovedAt ? null : store.data.meta.inmailRehearsal || null,
    inmailBalance: store.data.meta.inmailBalance ?? null,
    lastInvite: lastInvite(store, s.leads),
    learning: model ? { active: model.active, hardNo: model.hardNo, picks: model.picks, accepted: model.accepted, replied: model.replied, favours: model.favours, marksDown: model.marksDown } : null,
    noteStats: cfg?.connectionNotes ? noteStats(cfg.connectionNotes, store, c) : [],
    uiVersion: (() => { try { return fs.statSync(UI).mtimeMs; } catch { return 0; } })(),
    leads: rankLearned(s.leads, cfg?.role, model).map(l => {
      const co = store.companyFor(l);
      const months = l.tenureMonths ?? null;
      return {
        ...l,
        offLimits: l.offLimits || offLimits(l, clients)?.name || null,
        queued: l.queue.length, sent: l.messages.length,
        lastMessage: l.messages[l.messages.length - 1]?.text || '',
        // what the company page said wins over what the search card said
        sector: co?.sector || l.sector || '',
        sizeText: co?.sizeText || '',
        sizeWord: sizeWord(co?.size),
        tenure: tenureLabel(months),
        tenureMonths: months,
        tenureOk: tenureOk(months, minTenure),
        experience: tenureLabel(l.experienceMonths ?? null),
        tooJunior: tooJunior(l, minExperience),
        juniorTitle: isJunior(l.currentTitle) || isJunior(l.headline),
        overLevelled: cfg ? overLevelled(l, cfg) : false,
      };
    }),
    minTenureMonths: minTenure,
    minExperienceMonths: minExperience,
    seniority: level,
    seniorityLevels: SENIORITY,
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

const MAX_BODY = 15 * 1024 * 1024;   // a spec PDF, base64
async function body(req) {
  let b = '';
  for await (const ch of req) { b += ch; if (b.length > MAX_BODY) throw new Error('Request too large'); }
  return b ? JSON.parse(b) : {};
}

// Only this page may drive the app. A website open in the same browser cannot: its requests carry
// another Origin (or no JSON content type), and a DNS-rebinding page carries another Host.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
export function allowedRequest(req) {
  const host = req.headers.host || '';
  if (!LOCAL_HOST.test(host)) return 'bad host';
  if (req.method !== 'POST') return null;
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return 'JSON only';
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let o; try { o = new URL(origin); } catch { return 'bad origin'; }
    if (!LOCAL_HOST.test(o.host) || o.host !== host) return 'bad origin';
  } else if (origin === 'null') return 'bad origin';
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return 'cross-site';
  return null;
}
const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,40}$/i;

export function createApp({ jobs = new Jobs() } = {}) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const c = u.searchParams.get('c') || undefined;
    const refused = allowedRequest(req);
    if (refused) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: `refused: ${refused}` })); }
    try {
      if (req.method === 'GET' && u.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(UI, 'utf8'));
      }
      if (req.method === 'GET' && u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && u.pathname === '/api/state') return json(200, state(jobs, c));
      if (req.method === 'GET' && u.pathname === '/api/log') return json(200, { lines: jobs.since(+(u.searchParams.get('since') || 0)), job: jobs.status(), boot: jobs.boot });
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
        if (b.campaign && !NAME_RE.test(b.campaign)) return json(400, { error: 'bad role name' });
        if (['run', 'once', 'search', 'connect', 'followup'].includes(b.action) && !readCampaignRaw(b.campaign)) return json(400, { error: 'Pick a role first' });
        if (b.action === 'search' && b.url) { if (!/^https:\/\/www\.linkedin\.com\//.test(b.url)) return json(400, { error: 'search needs a linkedin.com URL' }); args.push(b.url); }
        if (b.action === 'record') { if (!/^https:\/\/www\.linkedin\.com\//.test(b.url || '')) return json(400, { error: 'record needs a linkedin.com URL' }); args.push(String(b.name || 'route').slice(0, 40), b.url); }
        if (b.action === 'probe') { if (!/^https:\/\/www\.linkedin\.com\//.test(b.url || '')) return json(400, { error: 'probe needs a linkedin.com URL' }); args.push(b.url); }
        // one browser for everything: a search asked for while a run is going is done on its next pass
        const busy = jobs.status();
        if (busy.running && b.action === 'search' && ['run', 'once'].includes(busy.name)) {
          askFor(b.campaign, 'search');
          return json(200, { ...busy, queued: 'search' });
        }
        return json(200, jobs.start(b.action, { campaign: b.campaign, args }));
      }
      if (u.pathname === '/api/approve') {
        const store = new Store();
        const clients = allClients();
        let n = 0;
        for (const url of [].concat(b.urls || b.url || [])) {
          const l = store.get(url);
          if (l && b.approved && offLimits(l, clients)) continue;          // never approve someone at a client
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
        store.setStatus(l.url, b.status, b.status === 'skipped' ? { error: 'excluded by hand', skippedByHand: true } : { skippedByHand: false, error: '' });
        store.save();
        return json(200, { ok: true });
      }
      if (u.pathname === '/api/queue') {
        if (!readCampaignRaw(b.campaign)) return json(400, { error: 'Pick a role first' });
        // items: [{ url, text, note?, notBefore?, resume? }]
        const tmp = path.join(HOME, `queue-${Date.now()}.json`);
        fs.writeFileSync(tmp, JSON.stringify(b.items || []));
        try { return json(200, { ok: true, n: queueMessages(new Store(), { name: b.campaign }, tmp) }); }
        finally { fs.rmSync(tmp, { force: true }); }
      }
      if (u.pathname === '/api/unqueue') {
        const store = new Store();
        const l = store.get(b.url);
        // matched by text, not position: the runner may have sent the first one meanwhile
        const i = l ? l.queue.findIndex(q => q.text === b.text) : -1;
        if (i < 0) return json(404, { error: 'That message is no longer waiting (it may have gone)' });
        l.queue.splice(i, 1); store.save();
        return json(200, { ok: true });
      }
      if (u.pathname === '/api/import') {
        if (!readCampaignRaw(b.campaign)) return json(400, { error: 'Pick a role first' });
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
        if (b.campaign && !NAME_RE.test(b.campaign)) return json(400, { error: 'bad role name' });
        let name = b.campaign || slugFor(role.title, role.location);
        // A new role never lands on an existing one, even with the same title and place.
        if (!b.campaign && readCampaignRaw(name)) name = `${name}-${Date.now().toString(36).slice(-4)}`;
        const existing = readCampaignRaw(name);
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
        const cfg = saveCampaign(name, { ...base, ...(existing ? {} : { mode: 'candidates', searchUrl: '' }), role: { ...role, geo: keep } });
        return json(200, { ok: true, campaign: name, cfg, preview: rolePreview(cfg) });
      }
      if (u.pathname === '/api/clear') {
        // { campaign } wipes the uncontacted people for this role
        if (!b.campaign) return json(400, { error: 'no role chosen' });
        if (jobs.status().running) return json(400, { error: 'Stop the running job first' });
        const store = new Store();
        if (b.dryRun) return json(200, { ok: true, n: store.clearUncontacted(b.campaign, { dryRun: true }) });
        const n = store.clearUncontacted(b.campaign);
        store.recordAction('cleared', '-', { campaign: b.campaign, n });
        store.save();
        return json(200, { ok: true, n });
      }
      if (u.pathname === '/api/preview') {
        // { campaign, url } every message exactly as this person would get it
        if (!readCampaignRaw(b.campaign)) return json(400, { error: 'Pick a role first' });
        const cfg = loadCampaign(b.campaign);
        const l = new Store().get(b.url);
        if (!l) return json(404, { error: 'no such person' });
        const one = (label, t) => t ? { label, ...renderChecked(t, l, cfg.role) } : null;
        const list = [
          ...cfg.connectionNotes.map((t, i) => one(cfg.connectionNotes.length > 1 ? `Connection note ${i + 1}` : 'Connection note', t)),
          ...cfg.followUps.map((f, i) => one(`After they accept, message ${i + 1}`, f.text)),
          cfg.inmail && one('InMail subject', cfg.inmail.subject), cfg.inmail && one('InMail', cfg.inmail.body), cfg.inmail && one('InMail follow-up', cfg.inmail.followUp),
          one('1st connections message', cfg.firstDegree?.message), one('1st connections follow-up', cfg.firstDegree?.followUp),
        ].filter(Boolean);
        return json(200, { name: l.name, firstName: nameFor(l), list });
      }
      if (u.pathname === '/api/firstname') {
        // { url, firstName } Kai fills in a name Sourcer could not read; a person held for it goes back to the list
        const store = new Store();
        const l = store.get(b.url);
        const fn = String(b.firstName || '').trim().slice(0, 40);
        if (!l) return json(404, { error: 'no such person' });
        if (!/^[\p{L}][\p{L}'. -]*$/u.test(fn)) return json(400, { error: 'Just their first name, letters only' });
        l.firstName = fn;
        if (/first name/.test(l.error || '')) { l.error = ''; if (l.status === 'error' && !l.invitedAt) l.status = 'new'; }
        store.save();
        return json(200, { ok: true });
      }
      if (u.pathname === '/api/direct') {
        // { campaign, urls } message these 1st connections: free, sent by the runner as LinkedIn messages
        if (!readCampaignRaw(b.campaign)) return json(400, { error: 'Pick a role first' });
        const store = new Store();
        const clients = allClients();
        const at = new Date().toISOString();
        let n = 0;
        for (const url of [].concat(b.urls || [])) {
          const l = store.get(url);
          if (!l || l.campaign !== b.campaign || l.status !== 'new' || cleanLead(l).degree !== '1st' || l.direct || offLimits(l, clients)) continue;
          store.setStatus(l.url, 'accepted', { degree: '1st', preexisting: true, acceptedAt: at, direct: { at }, approved: true });
          n++;
        }
        store.save();
        return json(200, { ok: true, n });
      }
      if (u.pathname === '/api/inmail-approve') {
        // Kai checked the rehearsal: from now on InMails go by themselves
        const store = new Store();
        if (b.ok) { store.data.meta.inmailApprovedAt = new Date().toISOString(); store.data.meta.inmailRehearsal = undefined; }
        else store.data.meta.inmailRehearsal = undefined;   // rejected: it rehearses again next pass
        store.save();
        return json(200, { ok: true });
      }
      if (u.pathname === '/api/inmail-sent') {
        // { url, kind: 'inmail' | 'followUp' } Kai pressed "Sent" after pasting it into Recruiter Lite
        const store = new Store();
        const l = store.get(b.url);
        if (!l) return json(404, { error: 'no such lead' });
        l.inmail = l.inmail || {};
        const at = new Date().toISOString();
        const field = b.kind === 'followUp' ? 'followUpAt' : 'sentAt';
        if (l.inmail[field]) return json(200, { ok: true, already: true });   // a double click never uses two credits
        l.inmail[field] = at;
        store.recordAction(b.kind === 'followUp' ? 'inmailFollowUp' : 'inmail', l.url, {});
        store.save();
        return json(200, { ok: true });
      }
      if (u.pathname === '/api/inmail-replied') {
        // { url } they answered the InMail: stop the lane, and Recruiter gives the credit back within 90 days
        const store = new Store();
        const l = store.get(b.url);
        if (!l) return json(404, { error: 'no such lead' });
        const first = !l.inmail?.replied;               // the credit comes back once
        l.inmail = { ...(l.inmail || {}), replied: l.inmail?.replied || new Date().toISOString() };
        if (first && l.inmail.sentAt && Date.now() - new Date(l.inmail.sentAt) < 90 * 86400000) store.recordAction('inmailRefund', l.url, {});
        store.setStatus(l.url, 'replied', { repliedAt: new Date().toISOString(), lastReply: String(b.text || 'Replied to the InMail (see Recruiter)').slice(0, 500) });
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

// When Sourcer's own files change (an update was copied in), the app restarts itself: the running
// job is stopped politely, remembered, and started again once the new version is up. Only when
// started by Sourcer.command, which starts the app again when it exits with code 75.
const RESUME = path.join(HOME, 'resume.json');
const SRC = path.dirname(fileURLToPath(import.meta.url));
function codeStamp() {
  let latest = 0;
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (/\.js$/.test(f.name)) latest = Math.max(latest, fs.statSync(p).mtimeMs);
  } };
  try { walk(SRC); } catch {}
  return latest;
}
function watchForUpdates(jobs) {
  let stamp = codeStamp(), changedAt = 0;
  setInterval(() => {
    const now = codeStamp();
    if (now !== stamp) { stamp = now; changedAt = Date.now(); return; }
    if (!changedAt || Date.now() - changedAt < 10000) return;      // wait until the copy has finished
    changedAt = 0;
    const cur = jobs.status();
    // never in the middle of a login or a recording Kai is doing by hand: try again later
    if (cur.running && ['login', 'login-recruiter', 'record', 'probe'].includes(cur.name)) { changedAt = Date.now(); return; }
    log('Sourcer was updated. Restarting to load the new version.');
    if (cur.running && ['run', 'search', 'once', 'followup', 'connect'].includes(cur.name)) {
      fs.writeFileSync(RESUME, JSON.stringify({ name: cur.name, campaign: cur.campaign, args: jobs.current?.args || [], at: new Date().toISOString() }), { mode: 0o600 });
    }
    if (cur.running) jobs.stop({ grace: 90000 });      // the person being contacted is finished first
    const wait = setInterval(() => { if (!jobs.status().running) { clearInterval(wait); process.exit(75); } }, 500);
    setTimeout(() => { jobs.killAll(); process.exit(75); }, 95000).unref();
  }, 5000).unref();
}
function resumeJob(jobs) {
  try {
    const r = JSON.parse(fs.readFileSync(RESUME, 'utf8'));
    fs.rmSync(RESUME, { force: true });
    if (r?.name && Date.now() - new Date(r.at) < 10 * 60000) {
      log(`carrying on with ${r.name} after the update`);
      jobs.start(r.name, { campaign: r.campaign, args: r.args || [] });
    }
  } catch {}
}

export function startApp({ port = 4747 } = {}) {
  const jobs = new Jobs();
  const server = createApp({ jobs });
  if (process.env.SOURCER_SUPERVISED) { watchForUpdates(jobs); resumeJob(jobs); }
  // Closing the Terminal window (or Ctrl+C) stops the running job and its Chrome too.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { jobs.killAll(); process.exit(0); });
  process.on('exit', () => jobs.killAll());
  server.listen(port, '127.0.0.1', () => log(`Sourcer is open at http://localhost:${port}`));
  return server;
}
