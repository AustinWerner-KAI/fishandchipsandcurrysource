// Ethereum EIP and ERC authors. A shallow clone of two public repositories, then the author line
// out of each file's front matter. CC0, no key, no rate limit, and the only source that hands over
// a real name and a GitHub handle in one structured field.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOME } from '../paths.js';
import { find, splitAuthored } from './shape.js';
import { mayFetch } from './registry.js';
import { log, warn } from '../log.js';

const run = promisify(execFile);
const REPOS = [
  { repo: 'https://github.com/ethereum/EIPs.git', dir: 'EIPS', kind: 'EIP' },
  { repo: 'https://github.com/ethereum/ERCs.git', dir: 'ERCS', kind: 'ERC' },
];
export const cacheDir = () => path.join(HOME, 'sources', 'eips');

// Front matter is between the first two --- lines. A byte order mark or a blank first line is
// tolerated, because one of those would otherwise throw the whole file away in silence.
export function parseEip(text, kind = 'EIP') {
  // A byte order mark is stripped by code point rather than by an escape in a regular expression,
  // so the source file stays plain ASCII and cannot be mangled in transit.
  let body = String(text || '');
  if (body.charCodeAt(0) === 0xFEFF) body = body.slice(1);
  body = body.replace(/^\s*\n/, '');
  const m = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const head = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-z-]+):[ \t]*(.*)$/i);
    if (kv) { key = kv[1].toLowerCase(); head[key] = kv[2].trim(); continue; }
    // a value carried onto the next line, either indented or as a YAML list item
    const more = line.match(/^[ \t]+(?:-[ \t]*)?(.+)$/);
    if (key && more) head[key] = [head[key], more[1].trim()].filter(Boolean).join(', ');
  }
  if (!head.eip && !head.erc) return null;
  return {
    kind, number: head.eip || head.erc, title: head.title || '', status: head.status || '',
    category: head.category || head.type || '', created: head.created || '',
    authors: splitAuthors(head.author),
  };
}

// Authors are comma separated, but a name can hold a comma of its own ("Smith, Jr. (@sj)"), so a
// fragment that is only a suffix belongs to the author before it. Everything else starts a new
// one, including a handle-style name in lower case such as "lightclient (@lightclient)".
const SUFFIX = /^(jr|sr|snr|ii|iii|iv|v|phd|ph\.d|md|esq)\.?$/i;

export function splitAuthors(line) {
  const parts = String(line || '').split(/,(?![^(]*\))/).map(p => p.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const withoutHandle = part.replace(/\s*[(<][^)>]*[)>]\s*/g, ' ').trim();
    if (out.length && SUFFIX.test(withoutHandle)) out[out.length - 1] = `${out[out.length - 1]}, ${part}`;
    else out.push(part);
  }
  return out;
}

async function refresh({ runner = run } = {}) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  for (const r of REPOS) {
    const dir = path.join(cacheDir(), r.kind);
    try {
      if (fs.existsSync(path.join(dir, '.git'))) {
        await runner('git', ['-C', dir, 'pull', '--quiet', '--depth', '1'], { timeout: 180000 });
      } else {
        await runner('git', ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse', r.repo, dir], { timeout: 300000 });
        await runner('git', ['-C', dir, 'sparse-checkout', 'set', r.dir], { timeout: 60000 });
      }
    } catch (e) { warn(`eips: could not update ${r.kind}:`, e.message.slice(0, 120)); }
  }
}

// Every author of every EIP and ERC, one find each. `since` keeps it to recent work.
export async function searchEips({ since = null, match = '', refreshFirst = true, runner = run } = {}) {
  mayFetch('eips');
  if (refreshFirst) await refresh({ runner });
  // Only proposals whose title or category mentions the role's main word. 24 Sep 2026, Kai's call:
  // this used to fall back to every recent author when nothing matched, which for a Cloud role
  // meant 919 Ethereum protocol people. Now no match means nobody from the EIPs for this role.
  if (!String(match || '').trim()) return [];
  const strict = collect({ since, match, runner });
  log(strict.length ? `eips: ${strict.length} author entries for "${match}"` : `eips: no proposal mentions "${match}", so nobody from the EIPs for this role`);
  return strict;
}


function collect({ since, match }) {
  const out = [];
  for (const r of REPOS) {
    const dir = path.join(cacheDir(), r.kind, r.dir);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
      const doc = parseEip(fs.readFileSync(path.join(dir, file), 'utf8'), r.kind);
      if (!doc) continue;
      if (since && doc.created && doc.created < since) continue;
      const hay = `${doc.title} ${doc.category}`.toLowerCase();
      if (match && !hay.includes(String(match).toLowerCase())) continue;
      for (const a of doc.authors) {
        const who = splitAuthored(a);
        if (!who.github && !who.name) continue;
        out.push(find('eips', {
          // no email: the addresses in these files are usually GitHub-issued ones, and GitHub's
          // own policy is that we do not take addresses from them
          handle: who.github, name: who.name, github: who.github,
          url: who.github ? `https://github.com/${who.github}` : '',
          lastActiveAt: doc.created || null,
          evidence: [{ label: `${doc.kind}-${doc.number}`, value: `${doc.title} (${doc.status || 'unknown'})` }],
          // a Core EIP is the hardest thing to get through review
          weight: doc.category?.toLowerCase() === 'core' ? 95 : 80,
        }));
      }
    }
  }
  return out;
}
