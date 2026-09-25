import fs from 'node:fs';
import { LOG_FILE, ensureDirs } from './paths.js';

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function log(...parts) {
  const line = `${stamp()}  ${parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`;
  console.log(line);
  try {
    ensureDirs();
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.rmSync(`${LOG_FILE}.1`, { force: true });
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
      fs.chmodSync(`${LOG_FILE}.1`, 0o600);
    }
    fs.appendFileSync(LOG_FILE, line + '\n', { mode: 0o600 });
    fs.chmodSync(LOG_FILE, 0o600);
  } catch {
    // logging must never break a run
  }
}

export function warn(...parts) {
  log('WARN', ...parts);
}
