// What each Search did, site by site, so the page can show it while it runs and afterwards.
// One row per role, the latest Search only, in its own small file (~/.sourcer/sweeps.json):
// it changes a dozen times a search, and db.json is too big and too important to churn for that.
// Only the runner writes it; the page reads it. Every write replaces the file whole, so a read
// never sees half of one.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, ensureDirs } from './paths.js';

const file = () => path.join(HOME, 'sweeps.json');
const now = () => new Date().toISOString();

export function readSweeps() {
  try { const all = JSON.parse(fs.readFileSync(file(), 'utf8')); return all && typeof all === 'object' ? all : {}; }
  catch { return {}; }
}

// Never lets a problem here stop a search: this is a display, not part of the work.
export function sweepUpdate(campaign, change) {
  if (!campaign) return;
  try {
    const all = readSweeps();
    all[campaign] = change({ ...(all[campaign] || {}) });
    ensureDirs();
    const tmp = `${file()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, file());
  } catch { /* the search carries on without its progress display */ }
}

export const sweepStart = campaign =>
  sweepUpdate(campaign, () => ({ state: 'running', startedAt: now(), finishedAt: null, terms: [], steps: {}, funnel: null }));

// One site (or Recruiter, or the name lookups): state is waiting, running, done, limited or failed.
export const sweepStep = (campaign, id, patch) =>
  sweepUpdate(campaign, r => ({ ...r, steps: { ...(r.steps || {}), [id]: { ...(r.steps?.[id] || {}), ...patch, at: now() } } }));

export const sweepSet = (campaign, patch) => sweepUpdate(campaign, r => ({ ...r, ...patch }));

// Ending a search settles every step: one still "running" was cut off, one still "waiting" was
// never reached. Otherwise the page would show spinners on a search that has finished.
export const sweepEnd = (campaign, state = 'done', extra = {}) =>
  sweepUpdate(campaign, r => ({
    ...r, ...extra, state, finishedAt: now(),
    steps: Object.fromEntries(Object.entries(r.steps || {}).map(([id, st]) => [id,
      st.state === 'running' ? { ...st, state: 'stopped' } : st.state === 'waiting' ? { ...st, state: 'skipped' } : st])),
  }));

// A deleted role's panel goes with it, so a new role of the same name starts clean.
export const sweepForget = campaign => sweepUpdate(campaign, () => undefined);
