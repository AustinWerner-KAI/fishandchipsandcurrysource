// What Kai asked for while a run was going (Search on another role). The app writes them here and
// the running job picks them up on its next pass, so everything still happens in one browser.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, ensureDirs } from './paths.js';

const FILE = () => path.join(HOME, 'requests.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return {}; }
}
function write(all) {
  ensureDirs();
  fs.writeFileSync(FILE(), JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function askFor(campaign, what = 'search') {
  const all = read();
  const list = new Set(all[campaign] || []);
  list.add(what);
  all[campaign] = [...list];
  write(all);
  return all[campaign];
}

export function pending(campaign) {
  const all = read();
  return campaign ? (all[campaign] || []) : all;
}

// Returns what was asked for and clears it, so a request never runs twice.
export function takeRequests(campaign) {
  const all = read();
  const mine = all[campaign] || [];
  if (mine.length) { delete all[campaign]; write(all); }
  return mine;
}
