// What Kai asked for while a run was going (Search on another role). The app writes them here and
// the running job picks them up on its next pass, so everything still happens in one browser.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, ensureDirs } from './paths.js';

const FILE = () => path.join(HOME, 'requests.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
function write(all) {
  ensureDirs();
  const tmp = `${FILE()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
  fs.chmodSync(FILE(), 0o600);
}
function locked(fn) {
  ensureDirs();
  const lock = `${FILE()}.lock`;
  const deadline = Date.now() + 3000;
  for (;;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch {}
      if (Date.now() > deadline) throw new Error('requests.json is locked by another process');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export function askFor(campaign, what = 'search') {
  return locked(() => {
    const all = read();
    const list = new Set(all[campaign] || []);
    list.add(what);
    all[campaign] = [...list];
    write(all);
    return all[campaign];
  });
}

export function pending(campaign) {
  const all = read();
  return campaign ? (all[campaign] || []) : all;
}

// Returns what was asked for and clears it, so a request never runs twice.
export function takeRequests(campaign) {
  return locked(() => {
    const all = read();
    const mine = all[campaign] || [];
    if (mine.length) { delete all[campaign]; write(all); }
    return mine;
  });
}
