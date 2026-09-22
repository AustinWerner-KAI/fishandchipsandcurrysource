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
  // Recruiter filters: a Locations box left open must never get the skill typed into it
  {
    const { addFacet } = await import('../src/actions/recruiter.js');
    const { SEL } = await import('../src/selectors.js');
    await page.setContent(`<div id="panel">
      <section><h3>Locations</h3><div id="chipsL"></div><button aria-label="Add a Candidate geographic location">+</button>
        <input id="loc" type="text" role="combobox" aria-controls="locList" style="display:none"><ul id="locList" role="listbox"></ul></section>
      <section><h3>Skills and Assessments</h3><div id="chipsS"></div><button aria-label="Add Skill keywords anywhere on profile">+ Skill keywords anywhere on profile</button>
        <input id="sk" type="text" role="combobox" aria-controls="skList" style="display:none"><ul id="skList" role="listbox"></ul></section></div>
      <ol id="res"><li data-test-paginated-profile-list-item-container><span data-test-row-lockup-full-name><a href="/talent/profile/r0">A</a></span></li></ol>
      <script>
        let n = 0; const bump = () => { document.querySelector('#res a').setAttribute('href', '/talent/profile/r' + (++n)); };
        const box = (btn, input, list, opts) => {
          document.querySelector(btn).onclick = () => { const i = document.querySelector(input); i.style.display = 'inline'; i.focus(); };
          document.querySelector(input).oninput = e => { const v = e.target.value.toLowerCase();
            document.querySelector(list).innerHTML = opts(v).map(o => '<li role="option">' + o + '</li>').join('');
            document.querySelectorAll(list + ' li').forEach(li => li.onclick = () => { document.querySelector(list === '#locList' ? '#chipsL' : '#chipsS').insertAdjacentHTML('beforeend', '<span>' + li.textContent + '</span>'); window.__picked = (window.__picked || []).concat(li.textContent); document.querySelector(list).innerHTML = ''; bump(); }); };
        };
        // like Recruiter: the Locations box suggests places for any text
        box('[aria-label="Add a Candidate geographic location"]', '#loc', '#locList', v => ['Vermont, United States', ...(v.includes('new') ? ['New York, United States'] : [])]);
        box('[aria-label="Add Skill keywords anywhere on profile"]', '#sk', '#skList', v => v.includes('azure') ? ['Microsoft Azure', 'Azure DevOps'] : []);
      </script>`);
    assert.equal(await addFacet(page, SEL.recruiterAddLocation, 'New York', 'location'), true);
    await page.evaluate(() => document.querySelector('#loc').focus());      // left open, as Recruiter does
    assert.equal(await addFacet(page, SEL.recruiterAddSkill, 'Azure', 'skill'), true);
    assert.deepEqual(await page.evaluate(() => window.__picked), ['New York, United States', 'Microsoft Azure']);
    assert.doesNotMatch(await page.inputValue('#loc'), /azure/i);
    // no suggestion that matches: nothing is picked
    assert.equal(await addFacet(page, SEL.recruiterAddSkill, 'Quantum Basketweaving', 'skill'), false);
    assert.deepEqual(await page.evaluate(() => window.__picked), ['New York, United States', 'Microsoft Azure']);
  }
  console.log('browser e2e: all good');
} finally {
  await context.close();
  server.close();
}
