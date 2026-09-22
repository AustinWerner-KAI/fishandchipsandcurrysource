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
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    // logging must never break a run
  }
}

export function warn(...parts) {
  log('WARN', ...parts);
}
