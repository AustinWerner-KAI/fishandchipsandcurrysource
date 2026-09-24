import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Everything the tool remembers lives in ~/.sourcer (override with SOURCER_HOME for tests).
export const HOME = process.env.SOURCER_HOME || path.join(os.homedir(), '.sourcer');
export const PROFILE_DIR = path.join(HOME, 'browser-profile');
export const DB_FILE = path.join(HOME, 'db.json');
export const LOG_FILE = path.join(HOME, 'sourcer.log');
export const SCREENSHOT_DIR = path.join(HOME, 'screenshots');
// Several public sources ask for a user agent that says who is calling and how to reach them.
// SOURCER_CONTACT should be an email address; without one they are within their rights to block us.
export const contactSet = () => /@/.test(process.env.SOURCER_CONTACT || '');
export const SOURCE_UA = `sourcer/1.0 (+${contactSet() ? process.env.SOURCER_CONTACT : 'contact-not-set'})`;

export const CAMPAIGN_DIR = path.resolve(process.env.SOURCER_CAMPAIGNS || path.join(process.cwd(), 'campaigns'));

export function ensureDirs() {
  for (const d of [HOME, PROFILE_DIR, SCREENSHOT_DIR]) fs.mkdirSync(d, { recursive: true });
}
