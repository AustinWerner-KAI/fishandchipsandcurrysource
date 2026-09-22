import fs from 'node:fs';
import { normalizeUrl } from '../store.js';
import { log } from '../log.js';

// Accepts a .txt (one URL per line) or a .csv with a header row containing url (and optionally name, headline, company).
export function importLeads(store, cfg, file, { approve = false } = {}) {
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let added = 0, skipped = 0;
  const isCsv = file.toLowerCase().endsWith('.csv') && lines.length && /url/i.test(lines[0]);
  const rows = isCsv ? parseCsv(lines) : lines.map(l => ({ url: l }));
  for (const r of rows) {
    const url = normalizeUrl(r.url);
    if (!url) { skipped++; continue; }
    const existed = !!store.get(url);
    const lead = store.upsertLead({ ...r, url, campaign: cfg.name, approved: approve });
    if (approve) lead.approved = true;
    if (existed) skipped++; else added++;
  }
  store.save();
  log(`import: ${added} added, ${skipped} skipped (already known or not a profile URL)`);
  return { added, skipped };
}

export function parseCsv(lines) {
  const header = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const cells = splitCsvLine(line);
    const o = {};
    header.forEach((h, i) => { o[h] = (cells[i] || '').trim(); });
    return o;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function exportCsv(store, cfg, { status } = {}) {
  const leads = store.leads({ campaign: cfg.name, status });
  const cols = ['url', 'name', 'headline', 'company', 'location', 'status', 'approved', 'score', 'notes', 'invitedAt', 'acceptedAt', 'repliedAt', 'lastReply'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [cols.join(','), ...leads.map(l => cols.map(c => esc(l[c])).join(','))].join('\n') + '\n';
}

// approve: a file with one URL per line, or '--all'
export function approveLeads(store, cfg, fileOrAll) {
  let n = 0;
  if (fileOrAll === '--all') {
    for (const l of store.leads({ campaign: cfg.name })) { l.approved = true; n++; }
  } else {
    const urls = fs.readFileSync(fileOrAll, 'utf8').split(/\r?\n/).map(normalizeUrl).filter(Boolean);
    for (const u of urls) {
      const l = store.get(u) || store.upsertLead({ url: u, campaign: cfg.name });
      l.approved = true; n++;
    }
  }
  store.save();
  log(`approved ${n} leads`);
  return n;
}

// queue: JSON array [{ url, text, notBefore?, note? }] of per-person messages (new business mode, or one-offs)
export function queueMessages(store, cfg, file) {
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(items)) throw new Error('Queue file must be a JSON array');
  let n = 0;
  for (const it of items) {
    const lead = store.get(it.url) || store.upsertLead({ url: it.url, campaign: cfg.name });
    if (!it.text) continue;
    if (/[—–]/.test(it.text)) throw new Error(`Message for ${it.url} contains a dash. Tone rules: no dashes.`);
    lead.queue.push({ text: it.text, notBefore: it.notBefore || null, note: it.note || '' });
    if (it.note) lead.notes = [lead.notes, it.note].filter(Boolean).join(' | ');
    n++;
  }
  store.save();
  log(`queued ${n} messages`);
  return n;
}
