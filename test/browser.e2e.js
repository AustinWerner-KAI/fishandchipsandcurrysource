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
  assert.deepEqual(await page.evaluate(() => window.__invited), ['Invite Ann Example to connect']);
  // Connect hidden under "More": must invite Cara, never the "People you may know" stranger
  r = await sendConnectionRequest(page, 'http://127.0.0.1:4790/in/follow-first/', 'Hey Cara.');
  assert.equal(r.result, 'sent');
  assert.deepEqual(await page.evaluate(() => window.__invited), ['Invite Cara Follow to connect']);
  // works at a client: the profile's current company stops the invite before any click
  const clients = [{ name: 'Kraken', slug: 'krakenfx', names: ['kraken'] }];
  r = await sendConnectionRequest(page, 'http://127.0.0.1:4790/in/at-client/', 'Hey Dee.', { clients });
  assert.equal(r.result, 'off-limits');
  assert.equal(r.info.companyText, 'Kraken');
  assert.deepEqual(await page.evaluate(() => window.__invited || []), []);
  // newer layout: name from the page title, degree after the name, Connect only inside her own card
  r = await sendConnectionRequest(page, 'http://127.0.0.1:4790/in/modern/', 'Hey Eve.');
  assert.equal(r.info.name, 'Eve Modern');
  assert.equal(r.info.degree, '2nd');
  assert.equal(r.result, 'sent');
  assert.deepEqual(await page.evaluate(() => window.__invited), ['c1']);
  assert.equal(await page.evaluate(() => window.__note), 'Hey Eve.');
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
  const ok = await sendMessageInOpenThread(page, t.editor, 'Thanks for connecting Bob. How are you finding the market?', 'Kai Crayford');
  assert.deepEqual(await page.evaluate(() => window.__sent), ['Thanks for connecting Bob. How are you finding the market?']);
  assert.equal(ok, true);
  const after = await readThread(page, 'Kai Crayford');
  assert.equal(after.lastFrom, 'me');
  await closeThread(page);
  assert.equal(await page.locator('#overlay').isVisible(), false);
  // Recruiter filters, built like Recruiter's real panel (saved 22 Sep): the + button is swapped
  // for a text box inside the filter's own wrapper. A Locations box left open must never get the skill.
  {
    const { addFacet } = await import('../src/actions/recruiter.js');
    await page.setContent(`<div id="panel">
      <div class="search-facet-wrapper facet-locations" data-test-facet-locations><div class="typeahead-facet"><section class="search-facet">
        <h2>Locations</h2><div class="chips"></div>
        <button class="facet-edit-button" data-test-facet-edit aria-label="Add a Candidate geographic location" type="button"><span>Candidate geographic locations</span></button><div class="slot"></div></section></div></div>
      <div class="search-facet-wrapper facet-skills" data-test-facet-skills><div class="typeahead-facet"><section class="search-facet">
        <h2>Skills and Assessments</h2><div class="chips"></div>
        <button class="facet-edit-button" data-test-facet-edit type="button"><span>Skill keywords anywhere on profile</span></button><div class="slot"></div></section></div></div></div>
      <ul id="overlay" role="listbox"></ul>
      <ol id="res"><li data-test-paginated-profile-list-item-container><span data-test-row-lockup-full-name><a href="/talent/profile/r0">A</a></span></li></ol>
      <script>
        let n = 0; const bump = () => { document.querySelector('#res a').setAttribute('href', '/talent/profile/r' + (++n)); };
        window.__picked = [];
        // like Recruiter: the button disappears and a box takes its place; suggestions may show outside the filter
        const facet = (wrapSel, listInside, opts) => {
          const wrap = document.querySelector(wrapSel);
          wrap.querySelector('button').onclick = e => {
            const input = document.createElement('input'); input.type = 'text'; input.setAttribute('role', 'combobox');
            e.currentTarget.replaceWith(input); input.focus();
            const list = listInside ? (wrap.querySelector('.slot').innerHTML = '<ul role="listbox"></ul>', wrap.querySelector('.slot ul')) : document.querySelector('#overlay');
            input.oninput = () => { const v = input.value.toLowerCase();
              list.innerHTML = opts(v).map(o => '<li role="option">' + o + '</li>').join('');
              list.querySelectorAll('li').forEach(li => li.onclick = () => { wrap.querySelector('.chips').insertAdjacentHTML('beforeend', '<span>' + li.textContent + '</span>'); window.__picked.push(li.textContent); list.innerHTML = ''; bump(); }); };
          };
        };
        facet('.facet-locations', false, v => ['Vermont, United States', ...(v.includes('new') ? ['New York, United States'] : [])]);
        facet('.facet-skills', true, v => v.includes('azure') ? ['Microsoft Azure', 'Azure DevOps'] : []);
      </script>`);
    assert.equal(await addFacet(page, 'location', 'New York'), true);
    assert.equal(await addFacet(page, 'skill', 'Azure'), true);
    assert.deepEqual(await page.evaluate(() => window.__picked), ['New York, United States', 'Microsoft Azure']);
    assert.doesNotMatch(await page.inputValue('.facet-locations input'), /azure/i);
    // no suggestion that matches: nothing is picked
    await page.evaluate(() => { const w = document.querySelector('.facet-skills'); w.querySelector('input').remove(); w.querySelector('section').insertAdjacentHTML('beforeend', '<button class="facet-edit-button" data-test-facet-edit type="button"><span>Skill keywords anywhere on profile</span></button>'); });
    await page.evaluate(() => { const w = document.querySelector('.facet-skills'); const b = w.querySelector('button'); b.onclick = e => { const i = document.createElement('input'); i.type = 'text'; e.currentTarget.replaceWith(i); i.focus(); }; });
    assert.equal(await addFacet(page, 'skill', 'Quantum Basketweaving'), false);
    assert.deepEqual(await page.evaluate(() => window.__picked), ['New York, United States', 'Microsoft Azure']);
  }
  console.log('browser e2e: all good');
} finally {
  await context.close();
  server.close();
}
