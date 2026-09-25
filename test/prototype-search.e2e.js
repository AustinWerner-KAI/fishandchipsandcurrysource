import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../design/sourcer-desktop-prototype/dist/', import.meta.url);
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = new URL('.' + (pathname === '/' ? '/index.html' : pathname), root);
    if (!file.href.startsWith(root.href)) throw new Error('outside root');
    res.setHeader('Content-Type', file.pathname.endsWith('.html') ? 'text/html' : 'text/javascript');
    res.end(await fs.readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await page.locator('#newSpec').isVisible(), true);
  for (const ext of ['docx', 'pdf']) {
    await page.locator('#newRoleButton').click();
    await page.locator('#specFile').setInputFiles(fileURLToPath(new URL(`fixtures/job-spec.${ext}`, import.meta.url)));
    await page.waitForFunction(() => document.querySelector('#specReadStatus').textContent.includes('loaded.'));
    assert.match(await page.locator('#newSpec').inputValue(), /Rust/);
    assert.match(await page.locator('#newTitle').inputValue(), /Rust Engineer/);
    assert.equal(await page.locator('#newLocation').inputValue(), 'London');
  }
  await page.locator('#newSkills').fill('Rust, Kubernetes');
  await page.getByRole('button', { name: 'Review tailored searches' }).click();
  const query = await page.locator('#newQueryOne').inputValue();
  await page.getByRole('button', { name: 'Save role & continue to search' }).click();
  const href = await page.locator('#runSearchOne').getAttribute('href');
  const url = new URL(href);
  assert.equal(url.origin, 'https://www.linkedin.com');
  assert.equal(url.searchParams.get('keywords'), query);
  assert.equal(url.searchParams.get('geoUrn'), '["102257491"]');
  // Verify the external navigation without logging in or sending any data to LinkedIn.
  await page.context().route('https://www.linkedin.com/**', route => route.fulfill({body:'Search destination'}));
  const opened = page.waitForEvent('popup');
  await page.locator('#runSearchOne').click();
  const popup = await opened;
  await popup.waitForLoadState();
  assert.equal(popup.url(), href);
  await popup.close();
  await page.reload();
  assert.equal(await page.locator('#runSearchOne').getAttribute('href'), href);
  assert.equal(await page.locator('#runSearchOne').isVisible(), true);
  await page.screenshot({path:'/tmp/sourcer-search-flow.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('#newRoleButton').isVisible(), true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS PDF and DOCX loading, role extraction, tailored search navigation, persistence and mobile layout');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
