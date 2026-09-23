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

const EMPTY = () => ({ meta: {}, leads: {}, companies: {}, actions: [] });

function parseDb(raw) {
  const data = { ...EMPTY(), ...JSON.parse(raw) };
  data.companies ||= {};
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
        if (now[k] === undefined) delete out.meta[k]; else out.meta[k] = now[k];
      }
    }
    // Companies are a cache: whatever we looked up this pass is written over disk's copy,
    // and a row is never removed by a merge.
    out.companies = { ...(disk.companies || {}) };
    for (const [k, c] of Object.entries(this.data.companies || {})) {
      if (this.baseCompanies[k] !== JSON.stringify(c)) out.companies[k] = c;
      else if (!out.companies[k]) out.companies[k] = c;
    }
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
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
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
      for (const k of ['name', 'headline', 'company', 'location', 'companyUrl', 'sector']) {
        if (partial[k] && !existing[k]) existing[k] = partial[k];
      }
      // Tenure only ever grows, and a stale reading would hold a good person back for months,
      // so a fresh one always wins.
      if (partial.tenureMonths != null) existing.tenureMonths = partial.tenureMonths;
      if (partial.tenureText) existing.tenureText = partial.tenureText;
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
      const clearable = l.status === 'new' || (l.status === 'skipped' && l.skippedByHand);
      if (clearable && !touched) { if (!dryRun) delete this.data.leads[url]; n++; }
    }
    return n;
  }

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
    if (!key) return null;
    const cur = this.data.companies[key] || { key, name: '', sector: '', size: null, sizeText: '', url: '', misses: 0 };
    this.data.companies[key] = { ...cur, ...fields, key, at: new Date().toISOString() };
    return this.data.companies[key];
  }

  // Employers we have a name for but have not looked up yet (or looked up long ago),
  // most common first so one pass covers the most people.
  companiesToLookUp({ campaign, staleDays = 180, maxMisses = 3, now = new Date() } = {}) {
    const counts = new Map();
    for (const l of this.leads(campaign ? { campaign } : {})) {
      const key = companyKey(l.companyUrl) || companyKey(l.company);
      if (!key) continue;
      const c = this.data.companies[key];
      if (c && (c.misses || 0) >= maxMisses) continue;
      // Only a company we actually read is left alone for a while. One we failed to read
      // is offered again next pass, until it has used up its tries.
      const known = c && (c.sector || c.size);
      if (known && now - new Date(c.at) < staleDays * 86400000) continue;
      const seen = counts.get(key) || { key, name: l.company || '', url: l.companyUrl || '', people: 0 };
      seen.people++;
      if (!seen.url && l.companyUrl) seen.url = l.companyUrl;
      if (!seen.name && l.company) seen.name = l.company;
      counts.set(key, seen);
    }
    return [...counts.values()].sort((a, b) => b.people - a.people);
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
