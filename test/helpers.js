import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sourcer-'));
  process.env.SOURCER_HOME = dir;
  return dir;
}
