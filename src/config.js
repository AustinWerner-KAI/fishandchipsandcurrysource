import fs from 'node:fs';
import path from 'node:path';
import { CAMPAIGN_DIR } from './paths.js';
import { DEFAULT_CAPS } from './limits.js';
import { WORK_TYPES } from './role.js';

const DEFAULTS = {
  mode: 'candidates',            // 'candidates' (template follow-ups) or 'newbusiness' (per-person queued messages)
  role: null,                    // { title, location, workType, candidateLocations, titles, domain, skills, exclude, boolean, geo: {name: id} }
  searchUrl: '',
  maxSearchPages: 5,
  autoApprove: false,            // false = only leads marked approved get a connection request
  connectionNotes: [],           // one or more; picked at random per lead. Empty = send without a note
  noteMaxLength: 300,
  followUps: [],                 // candidates mode: [{ afterDays: 2, afterHours: 0, text: '...' }]
  inmail: null,                  // Recruiter Lite lane, sent by hand: { afterDays: 7, subject, body, followUpAfterDays: 4, followUp }
  dailyCaps: { ...DEFAULT_CAPS },
  workingHours: { start: '09:30', end: '18:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Dubai' },
  pauseBetweenActionsSec: [45, 180],
  pauseBetweenCyclesMin: [15, 40],
  acceptanceCheckEveryHours: 3,          // how often to look at the connections page for new acceptances
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

// Writes a few keys into the campaign file and returns the reloaded, validated config.
export function patchCampaign(name, patch) {
  const file = path.join(CAMPAIGN_DIR, `${name}.json`);
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  Object.assign(raw, patch);
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return loadCampaign(name);
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
  if (cfg.role) {
    if (!cfg.role.title) errs.push('role.title is empty');
    if ((cfg.role.recruiterSkills || []).length > 2) errs.push('role.recruiterSkills: two at most');
    if (cfg.role.workType && !WORK_TYPES.includes(cfg.role.workType)) errs.push(`role.workType must be one of ${WORK_TYPES.join(', ')}`);
  }
  if (cfg.mode === 'candidates') {
    cfg.followUps.forEach((f, i) => {
      if (typeof f.afterDays !== 'number' || f.afterDays < 0) errs.push(`followUps[${i}].afterDays must be a number of days`);
      if (f.afterHours !== undefined && (typeof f.afterHours !== 'number' || f.afterHours < 0)) errs.push(`followUps[${i}].afterHours must be a number of hours`);
      if (!f.text) errs.push(`followUps[${i}].text is empty`);
    });
  }
  if (errs.length) throw new Error('Campaign config problems:\n - ' + errs.join('\n - '));
  return true;
}
