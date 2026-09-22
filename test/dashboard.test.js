import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const { Store } = await import('../src/store.js');
const { renderPage } = await import('../src/dashboard.js');

test('dashboard renders and escapes', () => {
  const s = new Store(path.join(home, 'db.json'));
  const l = s.upsertLead({ url: 'linkedin.com/in/a', name: 'Ann <b>A</b>', headline: 'CTO', campaign: 'c1' });
  s.setStatus(l.url, 'replied', { repliedAt: new Date().toISOString(), lastReply: 'yes "please"' });
  const html = renderPage(s, 'c1', ['c1']);
  assert.match(html, /Ann &lt;b&gt;A&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>A<\/b>/);
  assert.match(html, /chip-replied/);
  assert.match(html, /yes &quot;please&quot;/);
});
