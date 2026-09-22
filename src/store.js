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
  if (!m) return null;
  return `https://www.linkedin.com/in/${decodeURIComponent(m[1])}/`;
}

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

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...EMPTY(), ...parsed };
    } catch {
      this.data = EMPTY();
    }
    return this;
  }

  save() {
    ensureDirs();
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    return this;
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
