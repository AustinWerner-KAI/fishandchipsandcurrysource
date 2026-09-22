import fs from 'node:fs';
import { DB_FILE, ensureDirs } from './paths.js';

// A small JSON store. One person's outreach never needs more than this.
// Shape: { meta: { ownName }, leads: { [url]: Lead }, actions: Action[] }
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

const EMPTY = () => ({ meta: {}, leads: {}, actions: [] });

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
      if (e.code === 'ENOENT') { this.data = EMPTY(); return this; }
      throw e;
    }
    const parsed = JSON.parse(raw);
    this.data = { ...EMPTY(), ...parsed };
    for (const l of Object.values(this.data.leads)) {
      l.queue ||= []; l.messages ||= [];
    }
    return this;
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
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
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
      for (const k of ['name', 'headline', 'company', 'location']) {
        if (partial[k] && !existing[k]) existing[k] = partial[k];
      }
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
  clearUncontacted(campaign, statuses = ['new', 'skipped']) {
    let n = 0;
    for (const [url, l] of Object.entries(this.data.leads)) {
      if (l.campaign === campaign && statuses.includes(l.status)) { delete this.data.leads[url]; n++; }
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
  rekey(oldUrl, newUrl) {
    const from = normalizeUrl(oldUrl), to = normalizeUrl(newUrl);
    const lead = this.data.leads[from];
    if (!lead || !to || from === to) return this.data.leads[to] || lead;
    delete this.data.leads[from];
    if (this.data.leads[to]) { const keep = this.data.leads[to]; keep.recruiterUrl = keep.recruiterUrl || from; return keep; }
    lead.url = to; lead.recruiterUrl = from;
    this.data.leads[to] = lead;
    return lead;
  }

  leads(filter = {}) {
    return Object.values(this.data.leads).filter(l => {
      if (filter.campaign && l.campaign !== filter.campaign) return false;
      if (filter.status && ![].concat(filter.status).includes(l.status)) return false;
      return true;
    });
  }

  // ---- actions (what we did, when; drives the daily caps) ----
  recordAction(type, url, extra = {}) {
    this.data.actions.push({ type, url: normalizeUrl(url) || url, at: new Date().toISOString(), ...extra });
    // keep the action log bounded
    if (this.data.actions.length > 20000) this.data.actions = this.data.actions.slice(-15000);
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
