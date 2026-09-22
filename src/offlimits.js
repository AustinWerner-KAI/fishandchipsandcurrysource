// Clients are off limits: Sourcer never invites, messages or InMails anyone who works at one.
// Each role names its client (name, LinkedIn company page, other names). Every role's client
// is protected, not only the one being recruited for.
import fs from 'node:fs';
import path from 'node:path';
import { CAMPAIGN_DIR } from './paths.js';

const SUFFIX = /\b(inc|incorporated|ltd|limited|llc|llp|plc|gmbh|ag|sa|bv|nv|pte|pty|corp|corporation|co|company|group|holdings?|the)\b/g;
export const normCompany = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();

// "https://www.linkedin.com/company/kraken-exchange/" -> "kraken-exchange"
export function companySlug(url) {
  const m = String(url || '').match(/linkedin\.com\/(?:company|school|showcase)\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}

// The names one client is known by: its name, other names, and its company page address in words.
export function clientNames(client) {
  if (!client) return [];
  const slug = companySlug(client.url);
  const fromSlug = slug && !/^\d+$/.test(slug) ? slug.replace(/[-_]+/g, ' ') : '';
  return [...new Set([client.name, ...(client.otherNames || []), fromSlug].map(normCompany).filter(n => n.length >= 2))];
}

// Every client across every role: [{ name, slug, names }]
export function allClients(dir = CAMPAIGN_DIR) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))?.role?.client;
      if (c && (c.name || c.url)) out.push({ name: c.name || companySlug(c.url), slug: companySlug(c.url), names: clientNames(c) });
    } catch {}
  }
  return out;
}

// The current company from a headline: "Security Engineer at Kraken | Web3" -> "Kraken"
export function companyFromHeadline(headline) {
  const m = String(headline || '').match(/(?:\bat\b|@)\s*([^|,•·/()]+)/i);
  return m ? m[1].trim() : '';
}

const hasWord = (text, name) => new RegExp(`(^| )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(text);

// Which client this company text or company page belongs to, or null.
export function matchClient(clients, { company = '', companyUrl = '' } = {}) {
  const slug = companySlug(companyUrl);
  const text = normCompany(company);
  for (const c of clients) {
    if (slug && c.slug && slug === c.slug) return c;
    if (text && c.names.some(n => text === n || hasWord(text, n))) return c;
  }
  return null;
}

// For a person in the list: checks their stored company, then the company named in their headline.
export function offLimits(lead, clients) {
  if (!clients.length || !lead) return null;
  return matchClient(clients, { company: lead.company, companyUrl: lead.companyUrl })
    || matchClient(clients, { company: companyFromHeadline(lead.headline) });
}
