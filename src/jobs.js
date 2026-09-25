// Runs Sourcer commands as child processes so the web app never holds the browser itself.
// Only one browser job at a time: the logged-in browser profile can only be opened once.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const BROWSER_JOBS = new Set(['login', 'login-recruiter', 'search', 'run', 'once', 'followup', 'connect', 'probe', 'record']);

export class Jobs {
  constructor({ maxLines = 400 } = {}) {
    this.current = null;      // { name, campaign, startedAt, child }
    this.lines = [];          // ring buffer of { n, t, text }
    this.n = 0;
    this.maxLines = maxLines;
    this.history = [];        // last few finished jobs
    this.boot = Date.now();   // tells the page the log started again after an update
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
      stopping: !!c?.stopping,
      name: c?.name || null,
      campaign: c?.campaign || null,
      startedAt: c?.startedAt || null,
      pid: c?.child?.pid || null,
      history: this.history.slice(-5),
      boot: this.boot,
    };
  }

  start(name, { campaign, args = [], env = {} } = {}) {
    if (!BROWSER_JOBS.has(name)) throw new Error(`unknown job ${name}`);
    if (this.current) throw new Error(`${this.current.name} is already running. Stop it first.`);
    const cliArgs = name === 'once' ? ['run', campaign, '--once'] : name === 'login' ? ['login'] : name === 'login-recruiter' ? ['login-recruiter'] : name === 'probe' ? ['probe', ...args] : name === 'record' ? ['record', ...args] : [name, campaign, ...args];
    const child = spawn(process.execPath, [CLI, ...cliArgs], {
      cwd: process.cwd(),
      env: { ...process.env, ...env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',   // own process group: Stop can end the job AND its Chrome
    });
    const job = { name, campaign: campaign || null, args, startedAt: new Date().toISOString(), child };
    // keep the Mac awake while a job runs (ends by itself when the job does)
    if (process.platform === 'darwin' && !process.env.SOURCER_NO_CAFFEINATE) {
      try { const k = spawn('caffeinate', ['-i', '-w', String(child.pid)], { stdio: 'ignore', detached: true }); k.on('error', () => {}); k.unref(); } catch {}
    }
    this.current = job;
    this.push(`>>> ${name}${campaign ? ' ' + campaign : ''} started`);
    child.stdout.on('data', d => this.push(d));
    child.stderr.on('data', d => this.push(d));
    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      this.push(`<<< ${name} finished (${signal ? 'stopped' : 'exit ' + code})`);
      this.history.push({ ...job, child: undefined, endedAt: new Date().toISOString(), code, signal });
      if (this.current === job) this.current = null;
    };
    child.once('exit', finish);
    child.once('error', error => { this.push(`Could not start ${name}: ${error.message}`); finish(1, null); });
    return this.status();
  }

  // Polite first: a run finishes the person it is on (up to `grace`), then Chrome closes.
  stop({ grace = 25000 } = {}) {
    const c = this.current;
    if (!c) return this.status();
    if (c.stopping) { killGroup(c.child, 'SIGKILL'); return this.status(); }   // second press: no waiting
    c.stopping = true;
    this.push(`>>> stopping ${c.name}`);
    c.child.kill('SIGINT');                                   // polite: Playwright closes Chrome and exits
    setTimeout(() => { if (this.current === c) { this.push('>>> forcing stop'); killGroup(c.child, 'SIGKILL'); } }, c.name === 'run' || c.name === 'once' ? grace : 4000).unref();
    return this.status();
  }

  // The app is closing: take the running job and its browser with it.
  killAll() { if (this.current) killGroup(this.current.child, 'SIGKILL'); }
}

function killGroup(child, sig) {
  try { if (process.platform !== 'win32') process.kill(-child.pid, sig); else child.kill(sig); }
  catch { try { child.kill(sig); } catch {} }
}
