import fs from 'node:fs';
import path from 'node:path';
import { CAMPAIGN_DIR } from './paths.js';
import { DEFAULT_CAPS } from './limits.js';
import { WORK_TYPES } from './role.js';
import { unknownTags } from './template.js';

const DEFAULTS = {
  mode: 'candidates',            // 'candidates' (template follow-ups) or 'newbusiness' (per-person queued messages)
  role: null,                    // { title, location, workType, candidateLocations, titles, domain, skills, exclude, boolean, geo: {name: id} }
  searchUrl: '',
  maxSearchPages: 5,
  autoApprove: false,            // false = only leads marked approved get a connection request
  connectionNotes: [],           // one or more; picked at random per lead. Empty = send without a note
  noteMaxLength: 300,
  followUps: [],                 // candidates mode: [{ afterDays: 2, afterHours: 0, text: '...' }]
  // Already 1st degree connections: messages are free (no InMail credit). Sent by the runner as LinkedIn messages.
  firstDegree: {
    message: "Hi {firstName},\n\nHope you're well. I'm running a search for a {role} with a growing digital asset business in {location}. {workType}.\n\nYour background looks close to what they're after, so you were one of the first people I thought of.\n\nOpen to hearing a bit more? A yes or no is fine either way.\n\nKai",
    followUpAfterDays: 4,
    followUp: "Hi {firstName}, just bringing this back up in case it got buried. If the timing isn't right, no problem at all. Happy to keep you in mind for the next one. Kai",
  },
  // Recruiter Lite InMail lane. viaRecruiter sends it from the candidate's Recruiter profile.
  inmail: null,                  // { afterDays, monthlyCredits, perDay, viaRecruiter, subject, body, followUpAfterDays, followUp }, sent by hand: { afterDays: 7, subject, body, followUpAfterDays: 4, followUp }
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
    firstDegree: { ...DEFAULTS.firstDegree, ...(raw.firstDegree || {}) },
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
  if ((cfg.dailyCaps.weeklyConnects ?? 80) > 150) errs.push('weekly invites above 150 is asking for a restriction. Keep it at 150 or lower.');
  if (cfg.dailyCaps.messages > 40) errs.push('dailyCaps.messages above 40 is asking for a restriction. Keep it at 40 or lower.');
  for (const n of cfg.connectionNotes) {
    if (typeof n !== 'string') errs.push('connectionNotes must be strings');
    else if (n.length > cfg.noteMaxLength) errs.push(`connection note over ${cfg.noteMaxLength} chars: "${n.slice(0, 40)}..."`);
  }
  const pa = cfg.pauseBetweenActionsSec, pc = cfg.pauseBetweenCyclesMin;
  if (!Array.isArray(pa) || pa.length !== 2 || !(pa[0] >= 20) || !(pa[1] >= pa[0])) errs.push('pause between actions: at least 20 seconds, and the maximum not below the minimum');
  if (!Array.isArray(pc) || pc.length !== 2 || !(pc[0] >= 5) || !(pc[1] >= pc[0])) errs.push('pause between passes: at least 5 minutes');
  // a misspelt tag would quietly come out empty, so it is refused here
  const texts = [
    ...cfg.connectionNotes.map(t => ['Connection note', t]),
    ...cfg.followUps.map((f, i) => [`After they accept, message ${i + 1}`, f.text]),
    ...(cfg.inmail ? [['InMail subject', cfg.inmail.subject], ['InMail', cfg.inmail.body], ['InMail follow-up', cfg.inmail.followUp]] : []),
    ...(cfg.firstDegree ? [['1st connections message', cfg.firstDegree.message], ['1st connections follow-up', cfg.firstDegree.followUp]] : []),
  ];
  for (const [where, t] of texts) {
    const bad = unknownTags(t);
    if (bad.length) errs.push(`${where}: ${bad[0]} is not a tag. Use {firstName} {role} {location} {workType}`);
  }
  const fd = cfg.firstDegree;
  if (fd && (typeof fd.message !== 'string' || !fd.message.trim())) errs.push('1st connections: the message is empty');
  if (fd && !(Number(fd.followUpAfterDays) >= 1)) errs.push('1st connections: follow-up at least 1 day later');
  const wh = cfg.workingHours;
  if (wh) {
    try { new Intl.DateTimeFormat('en', { timeZone: wh.timezone || 'Asia/Dubai' }); } catch { errs.push(`working hours: "${wh.timezone}" is not a timezone (try America/New_York)`); }
    const hm = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '');
    if (!hm(wh.start || '09:00') || !hm(wh.end || '18:00')) errs.push('working hours: start and end must look like 09:00');
    else if ((wh.start || '09:00') >= (wh.end || '18:00')) errs.push('working hours: start must be before end');
    if (wh.days !== undefined && (!Array.isArray(wh.days) || !wh.days.length || !wh.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6))) errs.push('working hours: pick at least one day');
  }
  const cl = cfg.role?.client;
  if (cl?.url && !/^https?:\/\/([a-z]+\.)?linkedin\.com\/company\/[^/?#]+/i.test(cl.url)) errs.push('client: the link must be a LinkedIn company page, like linkedin.com/company/krakenfx');
  if (cl && !cl.name && !cl.url) errs.push('client: give a name or a company page link');
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
