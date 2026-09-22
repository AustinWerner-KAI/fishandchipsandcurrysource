// Drives the real Playwright flow against the fake LinkedIn. Run with: node test/browser.e2e.js
import { tmpHome } from './helpers.js';
tmpHome();
import assert from 'node:assert/strict';
import { startFake } from './fixtures/fake-linkedin.js';
const { openBrowser } = await import('../src/browser.js');
const { sendConnectionRequest, openThread, sendMessageInOpenThread, closeThread, readThread } = await import('../src/linkedin.js');

const server = await startFake();
const { context, page } = await openBrowser({ headless: true });
try {
  // connect with a note
  let r = await sendConnectionRequest(page, 'http://127.0.0.1:4790/in/ann/', 'Hey Ann, would be great to connect.');
  assert.equal(r.result, 'sent');
  assert.equal(await page.evaluate(() => window.__note), 'Hey Ann, would be great to connect.');
  assert.equal(r.info.name, 'Ann Example');
  assert.equal(r.info.degree, '2nd');
  // already pending
  r = await sendConnectionRequest(page, 'http://127.0.0.1:4790/in/pending/', 'x');
  assert.equal(r.result, 'pending');
  // already connected
  r = await sendConnectionRequest(page, 'http://127.0.0.1:4790/in/connected/', 'x');
  assert.equal(r.result, 'already-connected');
  // message thread: they spoke last
  let t = await openThread(page, 'http://127.0.0.1:4790/in/connected/', 'Kai Crayford');
  assert.equal(t.opened, true);
  assert.equal(t.lastFrom, 'them');
  assert.equal(t.lastText, 'Thanks for the invite!');
  const ok = await sendMessageInOpenThread(page, t.editor, 'Thanks for connecting Bob. How are you finding the market?');
  assert.equal(ok, true);
  const after = await readThread(page, 'Kai Crayford');
  assert.equal(after.lastFrom, 'me');
  await closeThread(page);
  assert.equal(await page.locator('#overlay').isVisible(), false);
  console.log('browser e2e: all good');
} finally {
  await context.close();
  server.close();
}
