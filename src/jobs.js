// Runs Sourcer commands as child processes so the web app never holds the browser itself.
// Only one browser job at a time: the logged-in browser profile can only be opened once.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const BROWSER_JOBS = new Set(['login', 'login-recruiter', 'search', 'run', 'once', 'followup', 'connect', 'probe']);

export class Jobs {
  constructor({ maxLines = 400 } = {}) {
    this.current = null;      // { name, campaign, startedAt, child }
    this.lines = [];          // ring buffer of { n, t, text }
    this.n = 0;
    this.maxLines = maxLines;
    this.history = [];        // last few finished jobs
  }

  push(text) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.lines.push({ n: ++this.n, t: Date.now(), text: line });
    }
    if (this.lines.length > this.maxLines) this.lines = this.lines.slice(-this.maxLines);
  }

  since(n = 0) {
    return this.lines.filter(l => l.n > n);
  }

  status() {
    const c = this.current;
    return {
      running: !!c,
      name: c?.name || null,
      campaign: c?.campaign || null,
      startedAt: c?.startedAt || null,
      pid: c?.child?.pid || null,
      history: this.history.slice(-5),
    };
  }

  start(name, { campaign, args = [], env = {} } = {}) {
    if (!BROWSER_JOBS.has(name)) throw new Error(`unknown job ${name}`);
    if (this.current) throw new Error(`${this.current.name} is already running. Stop it first.`);
    const cliArgs = name === 'once' ? ['run', campaign, '--once'] : name === 'login' ? ['login'] : name === 'login-recruiter' ? ['login-recruiter'] : name === 'probe' ? ['probe', ...args] : [name, campaign, ...args];
    const child = spawn(process.execPath, [CLI, ...cliArgs], {
      cwd: process.cwd(),
      env: { ...process.env, ...env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const job = { name, campaign: campaign || null, startedAt: new Date().toISOString(), child };
    this.current = job;
    this.push(`>>> ${name}${campaign ? ' ' + campaign : ''} started`);
    child.stdout.on('data', d => this.push(d));
    child.stderr.on('data', d => this.push(d));
    child.on('exit', (code, signal) => {
      this.push(`<<< ${name} finished (${signal ? 'stopped' : 'exit ' + code})`);
      this.history.push({ ...job, child: undefined, endedAt: new Date().toISOString(), code, signal });
      if (this.current === job) this.current = null;
    });
    return this.status();
  }

  stop() {
    const c = this.current;
    if (!c) return this.status();
    this.push(`>>> stopping ${c.name}`);
    c.child.kill('SIGINT');
    setTimeout(() => { if (this.current === c) c.child.kill('SIGTERM'); }, 5000).unref();
    return this.status();
  }
}
