import fs from 'node:fs';
import path from 'node:path';
import { CAMPAIGN_DIR } from './paths.js';
import { DEFAULT_CAPS } from './limits.js';

const DEFAULTS = {
  mode: 'candidates',            // 'candidates' (template follow-ups) or 'newbusiness' (per-person queued messages)
  searchUrl: '',
  maxSearchPages: 5,
  autoApprove: false,            // false = only leads marked approved get a connection request
  connectionNotes: [],           // one or more; picked at random per lead. Empty = send without a note
  noteMaxLength: 300,
  followUps: [],                 // candidates mode: [{ afterDays: 2, text: '...' }]
  dailyCaps: { ...DEFAULT_CAPS },
  workingHours: { start: '09:30', end: '18:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Dubai' },
  pauseBetweenActionsSec: [45, 180],
  pauseBetweenCyclesMin: [15, 40],
  acceptanceCheckEveryHours: 12,
};

export function listCampaigns() {
  if (!fs.existsSync(CAMPAIGN_DIR)) return [];
  return fs.readdirSync(CAMPAIGN_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));
}

export function loadCampaign(name) {
  if (!name) throw new Error('Campaign name required. Campaign files live in campaigns/<name>.json');
  const file = path.join(CAMPAIGN_DIR, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No campaign file at ${file}`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = {
    ...DEFAULTS,
    ...raw,
    name,
    dailyCaps: { ...DEFAULTS.dailyCaps, ...(raw.dailyCaps || {}) },
    workingHours: raw.workingHours === null ? null : { ...DEFAULTS.workingHours, ...(raw.workingHours || {}) },
  };
  validate(cfg);
  return cfg;
}

export function validate(cfg) {
  const errs = [];
  if (!['candidates', 'newbusiness'].includes(cfg.mode)) errs.push(`mode must be candidates or newbusiness`);
  for (const [k, v] of Object.entries(cfg.dailyCaps)) if (!(Number.isInteger(v) && v >= 0)) errs.push(`dailyCaps.${k} must be a whole number`);
  if (cfg.dailyCaps.connects > 25) errs.push('dailyCaps.connects above 25 is asking for a restriction. Keep it at 25 or lower.');
  if (cfg.dailyCaps.messages > 40) errs.push('dailyCaps.messages above 40 is asking for a restriction. Keep it at 40 or lower.');
  for (const n of cfg.connectionNotes) {
    if (typeof n !== 'string') errs.push('connectionNotes must be strings');
    else if (n.length > cfg.noteMaxLength) errs.push(`connection note over ${cfg.noteMaxLength} chars: "${n.slice(0, 40)}..."`);
  }
  if (cfg.mode === 'candidates') {
    cfg.followUps.forEach((f, i) => {
      if (typeof f.afterDays !== 'number' || f.afterDays < 0) errs.push(`followUps[${i}].afterDays must be a number of days`);
      if (!f.text) errs.push(`followUps[${i}].text is empty`);
    });
  }
  if (errs.length) throw new Error('Campaign config problems:\n - ' + errs.join('\n - '));
  return true;
}
