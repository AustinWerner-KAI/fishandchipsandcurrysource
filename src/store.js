import fs from 'node:fs';
import { DB_FILE, ensureDirs } from './paths.js';
import { companyKey } from './company.js';

// A small JSON store. One person's outreach never needs more than this.
// Shape: { meta: { ownName }, leads: { [url]: Lead }, companies: { [key]: Company }, actions: Action[] }
//
// A Company is a cache of what a company's LinkedIn page says: sector and headcount.
// Many candidates share one employer, so it is read once and reused.
//
// Lead statuses:
//   new       found by search or import, nothing sent
//   invited   connection request sent
//   accepted  they accepted, no message sent yet
//   messaged  at least one message sent, sequence not finished
//   replied   they wrote back. Nothing more is sent automatically.
//   done      sequence finished without a reply
//   skipped   we chose not to contact (already connected, no connect button, etc)
//   error     something broke on this profile; see lead.error

export const STATUSES = ['new', 'invited', 'accepted', 'messaged', 'replied', 'done', 'skipped', 'error'];

const EMPTY = () => ({ meta: {}, leads: {}, companies: {}, finds: {}, actions: [] });

// Meta keys holding a map of rows (one per learned step, one per lane) rather than a single value.
const MAP_META = new Set(['learned', 'health']);

// Only the rows this process changed are written over what is on disk now. A row we removed is
// removed; a row another process added while we were working is kept.
function mergeMap(was, now, disk) {
  if (!now || typeof now !== 'object' || Array.isArray(now)) return now;
  const base = was && typeof was === 'object' && !Array.isArray(was) ? was : {};
  const out = { ...(disk && typeof disk === 'object' && !Array.isArray(disk) ? disk : {}) };
  for (const key of new Set([...Object.keys(base), ...Object.keys(now)])) {
    if (JSON.stringify(base[key]) === JSON.stringify(now[key])) continue;
    if (now[key] === undefined) delete out[key]; else out[key] = now[key];
  }
  return out;
}

function parseDb(raw) {
  const data = { ...EMPTY(), ...JSON.parse(raw) };
  data.companies ||= {};
  data.finds ||= {};
  for (const l of Object.values(data.leads)) { l.queue ||= []; l.messages ||= []; }
  return data;
}

export function normalizeUrl(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/\/in\/([^/?#]+)/i);
  if (m) return `https://www.linkedin.com/in/${decodeURIComponent(m[1])}/`;
  // Recruiter Lite profile (found by a Recruiter search). Swapped for the /in/ URL when first opened.
  const t = u.pathname.match(/\/talent\/profile\/([A-Za-z0-9_-]+)/);
  if (t) return `https://www.linkedin.com/talent/profile/${t[1]}`;
  return null;
}

export const isRecruiterUrl = url => /\/talent\/profile\//.test(String(url || ''));

// Has anything actually gone to this person? Deliberately generous: keeping somebody who was
// never really contacted costs nothing, while dropping somebody who was risks approaching them
// twice, which is the one thing this tool must never do.
export const wasContacted = l => !!(l && (
  l.invitedAt || l.acceptedAt || l.repliedAt || l.direct
  || (l.messages && l.messages.length)
  || (l.inmail && (l.inmail.sentAt || l.inmail.replied))
  || ['invited', 'accepted', 'messaged', 'replied', 'done'].includes(l.status)
));

export function firstNameOf(name) {
  if (!name) return '';
  const clean = name.replace(/\(.*?\)/g, '').replace(/[,|].*$/, '').trim();
  const words = clean.split(/\s+/).filter(w => !/^(dr|mr|mrs|ms|miss|prof|sir|eng|ir)\.?$/i.test(w));
  const first = words[0] || '';
  return first.replace(/[^\p{L}\p{M}'-]/gu, '');
}

export class Store {
  constructor(file = DB_FILE) {
    this.file = file;
    this.data = EMPTY();
    this.load();
  }

  // Re-reads the file. A missing file means a fresh store; a corrupt file is an error, never silently wiped.
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
      fs.chmodSync(this.file, 0o600);
    } catch (e) {
      if (e.code === 'ENOENT') { this.data = EMPTY(); this.snapshot(); return this; }
      throw e;
    }
    this.data = parseDb(raw);
    this.snapshot();
    return this;
  }

  // Remembers what was read, so save() can tell our changes apart from other processes' changes.
  snapshot() {
    this.base = Object.fromEntries(Object.entries(this.data.leads).map(([k, l]) => [k, JSON.stringify(l)]));
    this.baseMeta = JSON.stringify(this.data.meta || {});
    this.baseCompanies = Object.fromEntries(Object.entries(this.data.companies || {}).map(([k, c]) => [k, JSON.stringify(c)]));
    this.baseFinds = Object.fromEntries(Object.entries(this.data.finds || {}).map(([k, f]) => [k, JSON.stringify(f)]));
    this.newActions = 0;
  }

  // Our copy merged onto what is on disk now: only the fields this process changed are written,
  // so an approval ticked in the app while the runner was typing a message is never lost.
  merged(disk) {
    const out = { ...disk, leads: { ...disk.leads } };
    for (const [k, l] of Object.entries(this.data.leads)) {
      const was = this.base[k];
      const now = JSON.stringify(l);
      if (was === now) continue;                           // untouched by us: keep disk's copy
      if (!was || !out.leads[k]) { out.leads[k] = l; continue; }
      const old = JSON.parse(was), theirs = { ...out.leads[k] };
      for (const f of new Set([...Object.keys(old), ...Object.keys(l)])) {
        if (JSON.stringify(old[f]) !== JSON.stringify(l[f])) {
          if (l[f] === undefined) delete theirs[f]; else theirs[f] = l[f];
        }
      }
      out.leads[k] = theirs;
    }
    for (const k of Object.keys(this.base)) if (!this.data.leads[k]) delete out.leads[k];   // removed by us
    if (JSON.stringify(this.data.meta || {}) !== this.baseMeta) {
      // only the meta keys this process changed or removed
      const was = JSON.parse(this.baseMeta), now = this.data.meta || {};
      out.meta = { ...disk.meta };
      for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (JSON.stringify(was[k]) === JSON.stringify(now[k])) continue;
        if (now[k] === undefined) { delete out.meta[k]; continue; }
        // `learned` and `health` are one row per step or lane, written by whichever process
        // noticed something. Treated as single values, the dashboard confirming one control would
        // wipe the row the runner had just written for another. So they merge row by row.
        out.meta[k] = MAP_META.has(k) ? mergeMap(was[k], now[k], disk.meta?.[k]) : now[k];
      }
    }
    // Companies are a cache: whatever we looked up this pass is written over disk's copy,
    // and a row is never removed by a merge.
    out.companies = { ...(disk.companies || {}) };
    for (const [k, c] of Object.entries(this.data.companies || {})) {
      if (this.baseCompanies[k] !== JSON.stringify(c)) out.companies[k] = c;
      else if (!out.companies[k]) out.companies[k] = c;
    }
    // Finds are rows of their own, merged one at a time so two passes never wipe each other.
    out.finds = { ...(disk.finds || {}) };
    for (const [k, f] of Object.entries(this.data.finds || {})) {
      if (this.baseFinds[k] !== JSON.stringify(f)) out.finds[k] = f;
      else if (!out.finds[k]) out.finds[k] = f;
    }
    for (const k of Object.keys(this.baseFinds || {})) if (!this.data.finds[k]) delete out.finds[k];

    const mine = this.newActions ? this.data.actions.slice(-this.newActions) : [];
    out.actions = [...(disk.actions || []), ...mine];
    if (out.actions.length > 20000) out.actions = out.actions.slice(-15000);
    return out;
  }

  // Several processes touch this file (runner, dashboard, CLI). A lock directory serialises writes
  // and the temp file carries the pid so two writers never rename each other's half-written file.
  save() {
    ensureDirs();
    const lock = this.file + '.lock';
    const deadline = Date.now() + 3000;
    for (;;) {
      try { fs.mkdirSync(lock); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // a lock older than 10s belongs to a dead process
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
        if (Date.now() > deadline) throw new Error('db.json is locked by another process');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      let disk = EMPTY();
      try { disk = parseDb(fs.readFileSync(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      this.data = this.merged(disk);
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      fs.chmodSync(this.file, 0o600);
      this.snapshot();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
    return this;
  }

  // Reload from disk and return the current copy of one lead. Call this right before mutating,
  // so an approval ticked on the dashboard or a message queued from the CLI is never overwritten.
  refresh(url) {
    this.load();
    return url ? this.get(url) : undefined;
  }

  // ---- leads ----
  get(url) {
    const key = normalizeUrl(url);
    return key ? this.data.leads[key] : undefined;
  }

  upsertLead(partial) {
    const url = normalizeUrl(partial.url);
    if (!url) throw new Error(`Not a LinkedIn profile URL: ${partial.url}`);
    const existing = this.data.leads[url];
    const now = new Date().toISOString();
    if (existing) {
      // keep status and history, refresh descriptive fields only when we have better ones
      for (const k of ['name', 'headline', 'company', 'location', 'companyUrl', 'sector', 'currentTitle']) {
        if (partial[k] && !existing[k]) existing[k] = partial[k];
      }
      // Tenure only ever grows, and a stale reading would hold a good person back for months,
      // so a fresh one always wins.
      if (partial.tenureMonths != null) existing.tenureMonths = partial.tenureMonths;
      if (partial.tenureText) existing.tenureText = partial.tenureText;
      if (partial.experienceMonths != null) existing.experienceMonths = partial.experienceMonths;
      if (partial.holdOverride != null) existing.holdOverride = partial.holdOverride;
      if (partial.historyTruncated != null) existing.historyTruncated = partial.historyTruncated;
      if (partial.name && !existing.firstName) existing.firstName = firstNameOf(partial.name);
      existing.updatedAt = now;
      return existing;
    }
    const lead = {
      url,
      name: partial.name || '',
      firstName: partial.firstName || firstNameOf(partial.name || ''),
      headline: partial.headline || '',
      degree: partial.degree || '',
      company: partial.company || '',
      companyUrl: partial.companyUrl || '',
      sector: partial.sector || '',                 // what Recruiter said, until the company page is read
      tenureText: partial.tenureText || '',         // "2 yrs 4 mos" as LinkedIn wrote it
      tenureMonths: partial.tenureMonths ?? null,   // the same in months, null when we could not read it
      currentTitle: partial.currentTitle || '',
      experienceMonths: partial.experienceMonths ?? null,   // commercial months, internships not counted
      historyTruncated: !!partial.historyTruncated,         // the card hid older roles, so the total is a floor
      holdOverride: !!partial.holdOverride,                 // Kai overruled a tenure or seniority hold
      location: partial.location || '',
      campaign: partial.campaign || 'default',
      status: 'new',
      approved: !!partial.approved,
      score: partial.score ?? null,
      notes: partial.notes || '',
      queue: [],          // per-lead messages waiting to be sent: [{ text, notBefore, note }]
      messages: [],       // sent messages: [{ step|null, text, at }]
      invitedAt: null,
      acceptedAt: null,
      repliedAt: null,
      lastReply: null,
      lastCheckedAt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.data.leads[url] = lead;
    return lead;
  }

  setStatus(url, status, extra = {}) {
    if (!STATUSES.includes(status)) throw new Error(`Unknown status ${status}`);
    const lead = this.get(url);
    if (!lead) throw new Error(`Unknown lead ${url}`);
    lead.status = status;
    Object.assign(lead, extra, { updatedAt: new Date().toISOString() });
    return lead;
  }

  // Remove people from a campaign who were never contacted (status new or skipped). Anyone invited,
  // messaged or replied stays, so a fresh search can never contact them twice.
  clearUncontacted(campaign, { dryRun = false } = {}) {
    let n = 0;
    for (const [url, l] of Object.entries(this.data.leads)) {
      if (l.campaign !== campaign) continue;
      const touched = l.invitedAt || l.acceptedAt || (l.messages && l.messages.length) || (l.queue && l.queue.length) || l.inmail;
      // Somebody excluded by hand is never removed. Removing them is the same as un-excluding
      // them: the next search finds them again and puts them straight back in the list.
      // The ones LinkedIn ruled out for us (a client, no Connect button) go, and are judged afresh.
      const clearable = l.status === 'new' || (l.status === 'skipped' && !l.skippedByHand);
      if (clearable && !touched) { if (!dryRun) delete this.data.leads[url]; n++; }
    }
    return n;
  }

  // Delete a role: its people who were never contacted go with it, and anyone who was contacted
  // stays on file. Keeping them is the whole point. They no longer show anywhere, but a later
  // search still finds them already on file and will not approach them a second time.
  deleteCampaign(campaign, { dryRun = false } = {}) {
    let removed = 0, kept = 0;
    const at = new Date().toISOString();
    for (const [url, l] of Object.entries(this.data.leads)) {
      if (l.campaign !== campaign) continue;
      // Excluded by hand counts as a decision about that person, and outlives the role.
      if (wasContacted(l) || l.skippedByHand) { kept++; if (!dryRun) { l.roleDeletedAt = at; l.approved = false; } }
      else { removed++; if (!dryRun) delete this.data.leads[url]; }
    }
    return { removed, kept };
  }

  // ---- finds (people seen on the public sources, who have no LinkedIn profile yet) ----

  // One row per human, whichever sites saw them. Merged on the way in, so a second pass adds
  // evidence rather than a duplicate.
  upsertFind(key, fields = {}) {
    if (!key) return null;
    const cur = this.data.finds[key];
    const now = new Date().toISOString();
    if (!cur) {
      this.data.finds[key] = {
        key, name: '', github: '', company: '', location: '', url: '',
        sources: [], evidence: [], weight: 0, lastActiveAt: null,
        campaign: '', foundAt: now,
        lookedUpAt: null, matchedUrl: null, outcome: '',   // how the LinkedIn lookup went
        ...fields, updatedAt: now,
      };
      return this.data.finds[key];
    }
    // a find hidden as noise comes back when a search really turns them up again
    if (cur.hidden) delete cur.hidden;
    // whatever we did not know before, and the strongest weight seen
    for (const k of ['name', 'github', 'company', 'location', 'url', 'campaign']) if (fields[k] && !cur[k]) cur[k] = fields[k];
    if (fields.weight != null) cur.weight = Math.max(cur.weight || 0, fields.weight);
    if (fields.lastActiveAt && (!cur.lastActiveAt || fields.lastActiveAt > cur.lastActiveAt)) cur.lastActiveAt = fields.lastActiveAt;
    cur.sources = [...new Set([...(cur.sources || []), ...(fields.sources || [])])];
    const seen = new Set((cur.evidence || []).map(e => `${e.label}|${e.value}`));
    for (const e of fields.evidence || []) if (!seen.has(`${e.label}|${e.value}`)) { cur.evidence.push(e); seen.add(`${e.label}|${e.value}`); }
    if (cur.evidence.length > 8) cur.evidence = cur.evidence.slice(0, 8);
    cur.updatedAt = now;
    return cur;
  }

  // Hidden finds are noise Kai chose to drop (24 Sep 2026: the EIPs fallback's 919 protocol authors
  // on a Cloud role). They are marked, not deleted: finds are a cache that a merge never removes, so a
  // running process would put a deleted row straight back on its next save.
  findRows(campaign) {
    return Object.values(this.data.finds || {}).filter(f => !f.hidden && (!campaign || f.campaign === campaign));
  }

  // The same person already in this role under another address: Recruiter files people under their
  // /talent/ link, LinkedIn and the public sources under their /in/ link, so one human can arrive
  // twice. A full name must match (first and last, in order), and the company too when both have
  // one. Used so nobody Kai excluded or already contacted comes back by another route (24 Sep 2026).
  findTwin(campaign, name, company = '', { onlyExcluded = false } = {}) {
    // "Dr. Jane Doe, CISSP (She/Her)" is Jane Doe: honorifics, anything after a comma, and brackets go
    const words = n => String(n || '').toLowerCase().normalize('NFKD')
      .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').split(',')[0]
      .replace(/^\s*(dr|mr|mrs|ms|miss|prof|sir|eng|ir)\.?\s+/, '')
      .replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim().split(' ')
      .filter(w => w && !/^(phd|mba|cissp|cism|cisa|ccsp|cpa|cfa|pmp|oscp|msc|bsc|ma|jr|sr|ii|iii)$/.test(w));
    const want = words(name);
    // hidden profiles all show as "LinkedIn Member": that is nobody in particular
    if (want.length < 2 || (want[0] === 'linkedin' && want[1] === 'member')) return null;
    // "Acme", "Acme Inc." and "ACME Ltd" are one company
    const co = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\b(inc|incorporated|ltd|limited|llc|llp|plc|gmbh|ag|sa|bv|corp|corporation|co|company|group|holdings)\b/g, ' ').replace(/\s+/g, '');
    // exact after the suffix goes ("Meta" is not "Metaco"); a name that is only a suffix word is compared whole
    const sameCo = (a, b) => { const x = co(a) || String(a).toLowerCase().trim(), y = co(b) || String(b).toLowerCase().trim(); return x === y; };
    return Object.values(this.data.leads).find(l => {
      if (l.campaign !== campaign) return false;
      if (onlyExcluded && !l.skippedByHand) return false;
      const have = words(l.name);
      if (have.length < 2 || have[0] !== want[0] || have[have.length - 1] !== want[want.length - 1]) return false;
      return onlyExcluded || !(company && l.company && !sameCo(company, l.company));
    }) || null;
  }

  // Someone Kai excluded by hand with this name, whatever company they show now. Used so an
  // excluded person never comes back under another address; the cost is that a different person
  // with exactly the same name is left out too, which Kai asked for over the reverse.
  excludedTwin(campaign, name) { return this.findTwin(campaign, name, '', { onlyExcluded: true }); }

  // A person found in Recruiter keeps their Recruiter URL after they are moved to their /in/ URL.
  findByRecruiterUrl(url) {
    const k = normalizeUrl(url);
    return this.data.leads[k] || Object.values(this.data.leads).find(l => l.recruiterUrl === k) || null;
  }

  // Move a lead from its Recruiter key to its normal /in/ key. If that person is already on file
  // (found another way), keep the existing record and drop this one.
  // Returns { lead } when moved, or { conflict } when the /in/ URL is already on file (nothing is changed then).
  rekey(oldUrl, newUrl) {
    const from = normalizeUrl(oldUrl), to = normalizeUrl(newUrl);
    const lead = this.data.leads[from];
    if (!lead || !to) return { lead: null };
    if (from === to) return { lead };
    if (this.data.leads[to]) return { conflict: this.data.leads[to] };
    delete this.data.leads[from];
    lead.url = to; lead.recruiterUrl = from;
    this.data.leads[to] = lead;
    return { lead };
  }

  leads(filter = {}) {
    return Object.values(this.data.leads).filter(l => {
      if (filter.campaign && l.campaign !== filter.campaign) return false;
      if (filter.status && ![].concat(filter.status).includes(l.status)) return false;
      return true;
    });
  }

  // ---- companies (sector and headcount, read once per employer) ----

  // What we know about this person's employer, or null. Never triggers a lookup.
  companyFor(lead) {
    const key = companyKey(lead?.companyUrl) || companyKey(lead?.company);
    return key ? this.data.companies[key] || null : null;
  }

  // Remembers a company's page. `at` is when it was read, so it can be refreshed later.
  setCompany(nameOrUrl, fields = {}) {
    const key = companyKey(nameOrUrl);
    return key ? this.setCompanyAt(key, fields) : null;
  }

  // The same, for a key worked out already.
  setCompanyAt(key, fields = {}) {
    if (!key) return null;
    const cur = this.data.companies[key] || { key, name: '', sector: '', size: null, sizeText: '', url: '', misses: 0 };
    this.data.companies[key] = { ...cur, ...fields, key, at: new Date().toISOString() };
    return this.data.companies[key];
  }

  // One more failed try for this employer. Counted against the key the queue uses, so three
  // misses really do stop it being fetched again.
  countMiss(key, name = '') {
    if (!key) return null;
    const cur = this.data.companies[key];
    return this.setCompanyAt(key, { name: cur?.name || name, misses: (cur?.misses || 0) + 1 });
  }

  // Employers we have a name for but have not looked up yet (or looked up long ago),
  // most common first so one pass covers the most people.
  companiesToLookUp({ campaign, staleDays = 180, maxMisses = 3, now = new Date() } = {}) {
    const counts = new Map();
    const settled = c => {
      if (!c) return false;
      if ((c.misses || 0) >= maxMisses) return true;                 // given up on
      // Only a company we actually read is left alone for a while. One we failed to read
      // is offered again next pass, until it has used up its tries.
      return !!(c.sector || c.size) && now - new Date(c.at) < staleDays * 86400000;
    };
    for (const l of this.leads(campaign ? { campaign } : {})) {
      // One employer can reach us as a page URL on one card and a bare name on another.
      // Both spellings must land on one row, or it is looked up twice and the people count
      // that orders this queue is split in half.
      const keys = [companyKey(l.companyUrl), companyKey(l.company)].filter(Boolean);
      if (!keys.length) continue;
      if (keys.some(k => settled(this.data.companies[k]))) continue;
      const key = keys.find(k => this.data.companies[k]) || keys[0];
      const seen = counts.get(keys[0]) || counts.get(keys[keys.length - 1])
        || { key, name: l.company || '', url: l.companyUrl || '', people: 0, keys: new Set() };
      seen.people++;
      keys.forEach(k => seen.keys.add(k));
      if (!seen.url && l.companyUrl) seen.url = l.companyUrl;
      if (!seen.name && l.company) seen.name = l.company;
      for (const k of keys) counts.set(k, seen);
    }
    return [...new Set(counts.values())].sort((a, b) => b.people - a.people);
  }

  // ---- actions (what we did, when; drives the daily caps) ----
  recordAction(type, url, extra = {}) {
    this.data.actions.push({ type, url: normalizeUrl(url) || url, at: new Date().toISOString(), ...extra });
    this.newActions++;
  }

  actionsSince(sinceIso, type) {
    return this.data.actions.filter(a => a.at >= sinceIso && (!type || a.type === type));
  }

  counts(campaign) {
    const out = Object.fromEntries(STATUSES.map(s => [s, 0]));
    for (const l of this.leads({ campaign })) out[l.status]++;
    out.total = this.leads({ campaign }).length;
    return out;
  }
}
