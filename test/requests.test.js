import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const { pending, askFor, takeRequests } = await import('../src/requests.js');

test('concurrent request writers retain all queued roles', async () => {
  const moduleUrl = new URL('../src/requests.js', import.meta.url).href;
  await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {askFor} from ${JSON.stringify(moduleUrl)}; askFor('role-${i}');`], { env: { ...process.env, SOURCER_HOME: home }, stdio: 'pipe' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
  })));
  assert.equal(Object.keys(pending()).length, 8);
  assert.deepEqual(takeRequests('role-0'), ['search']);
  assert.deepEqual(takeRequests('role-0'), []);
  assert.equal(Object.keys(pending()).length, 7);
});

test('corrupt request storage fails without overwriting it', () => {
  const file = path.join(home, 'requests.json');
  fs.writeFileSync(file, '{broken');
  assert.throws(() => askFor('new-role'), SyntaxError);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
