// Profile-level operations. Each returns a plain result and never throws on "LinkedIn looks different",
// only on checkpoint / logged out (see browser.guard).
//
// Every action button is looked up inside the profile's top card AND by the person's name
// ("Invite Jane Doe to connect"), so a suggested-people card further down the page is never clicked.
import { SEL, firstVisible, anyPresent, withName } from './selectors.js';
import { goto, guard, humanScroll, snap, saveDom, typeLikeHuman } from './browser.js';
import { sleep, randomBetween } from './limits.js';
import { log, warn } from './log.js';
import { normalizeUrl, firstNameOf } from './store.js';
import { matchClient, companyFromHeadline } from './offlimits.js';

async function textOf(scope, candidates) {
  const loc = await firstVisible(scope, candidates, 1500);
  if (!loc) return '';
  return (await loc.innerText()).trim();
}

// The profile's own top card. When LinkedIn's layout has no h1, it is found from the person's name:
// the nearest block around the name that also holds buttons. Null when it cannot be found, and
// then nothing is clicked.
async function topCard(page, name) {
  const byClass = await firstVisible(page, SEL.topCard.slice(0, 2), 2500);
  if (byClass) return byClass;
  if (!name) return null;
  const found = await page.evaluate(n => {
    document.querySelectorAll('[data-sourcer-topcard]').forEach(x => x.removeAttribute('data-sourcer-topcard'));
    const leaf = [...document.querySelectorAll('main *, body *')].find(e => e.children.length === 0 && e.textContent.trim() === n && e.offsetParent !== null);
    if (!leaf) return false;
    for (let a = leaf.parentElement, i = 0; a && a !== document.body && i < 12; a = a.parentElement, i++) {
      if (a.querySelectorAll('button').length >= 2) { a.setAttribute('data-sourcer-topcard', '1'); return true; }
    }
    return false;
  }, name).catch(() => false);
  return found ? page.locator('[data-sourcer-topcard="1"]').first() : null;
}

// "(7) John Lawniczak | LinkedIn" -> "John Lawniczak"
async function nameFromTitle(page) {
  const t = await page.title().catch(() => '');
  const n = t.replace(/^\(\d+\+?\)\s*/, '').split('|')[0].split(' - ')[0].trim();
  if (!n || /^linkedin$/i.test(n) || n.length > 80) return '';
  const onPage = await page.evaluate(x => document.body.innerText.includes(x), n).catch(() => false);
  return onPage ? n : '';
}

export async function readProfile(page) {
  const name = (await textOf(page, SEL.profileName)).split('\n')[0].trim() || await nameFromTitle(page);
  const headline = await textOf(page, SEL.profileHeadline);
  const degreeRaw = await textOf(page, SEL.profileDegree);
  let degree = (degreeRaw.match(/\b(1st|2nd|3rd)\b/) || [''])[0];
  if (!degree && name) {
    // "John Lawniczak · 2nd": the degree printed right after the name
    degree = await page.evaluate(n => { const t = document.body.innerText; const i = t.indexOf(n); const m = i >= 0 && t.slice(i + n.length, i + n.length + 40).match(/\b(1st|2nd|3rd)\b/); return m ? m[1] : ''; }, name).catch(() => '');
  }
  const cur = await firstVisible(page, SEL.profileCurrentCompany, 800);
  const companyText = cur ? String(await cur.getAttribute('aria-label').catch(() => '') || '').replace(/^Current company:\s*/i, '').replace(/\.\s*Click.*$/i, '').trim() : '';
  let companyUrls = [];
  for (const sel of SEL.profileCompanyLinks) {
    companyUrls = await page.locator(sel).evaluateAll(as => as.slice(0, 2).map(a => a.href)).catch(() => []);
    if (companyUrls.length) break;
  }
  return { name, firstName: firstNameOf(name), headline, degree, companyText, companyUrls };
}

// The client this open profile works at, if any (checked before any button is pressed).
function clientOnProfile(info, clients) {
  if (!clients?.length) return null;
  return matchClient(clients, { company: info.companyText })
    || info.companyUrls.map(u => matchClient(clients, { companyUrl: u })).find(Boolean)
    || matchClient(clients, { company: companyFromHeadline(info.headline) });
}

export async function openProfile(page, url) {
  await goto(page, normalizeUrl(url) || url);
  await humanScroll(page, { steps: 2 });
  const info = await readProfile(page);
  if (!info.name) {
    await snap(page, 'no-profile-name');
    await saveDom(page, 'no-profile-name');
    warn('could not read the profile name; buttons will only be matched inside the top card');
  }
  return info;
}

// What the top card offers for this person.
async function topCardButtons(page, name) {
  const card = await topCard(page, name);
  if (!card) return { card: null };
  const connect = await firstVisible(card, withName(SEL.connectButton, name), 1200);
  const pending = await firstVisible(card, SEL.pendingButton, 600);
  const message = await firstVisible(card, withName(SEL.messageButton, name), 800);
  const more = await firstVisible(card, SEL.moreActionsButton, 600);
  return { card, connect, pending, message, more };
}

// Returns one of: 'sent' | 'already-connected' | 'pending' | 'no-button' | 'weekly-limit' | 'email-required' | 'failed'
export async function sendConnectionRequest(page, url, note, { clients } = {}) {
  const info = await openProfile(page, url);
  const client = clientOnProfile(info, clients);
  if (client) return { result: 'off-limits', info, client };
  if (!(await topCard(page, info.name))) { await snap(page, 'no-top-card'); await saveDom(page, 'no-top-card'); return { result: 'failed', info }; }
  if (!info.name) return { result: 'failed', info };   // without the name, a suggested-person card could be clicked
  const b = await topCardButtons(page, info.name);
  if (info.degree === '1st') return { result: 'already-connected', info };
  if (b.pending) return { result: 'pending', info };

  let btn = b.connect;
  if (!btn && b.more) {
    await b.more.click();
    await sleep(randomBetween(600, 1200));
    const menu = await firstVisible(page, SEL.moreMenu, 1500);
    btn = menu ? await firstVisible(menu, withName(SEL.moreMenuConnect, info.name), 1500) : null;
    if (!btn) await page.keyboard.press('Escape').catch(() => {});
  }
  if (!btn) {
    // no Connect anywhere for this person. If there is a Message button and no Connect, they are already connected.
    if (b.message && !info.degree) return { result: 'already-connected', info };
    await snap(page, 'no-connect-button');
    return { result: 'no-button', info };
  }
  await btn.click();
  await sleep(randomBetween(900, 1800));
  await guard(page);

  if (await anyPresent(page, SEL.weeklyLimitText, 1000)) {
    await snap(page, 'weekly-limit');
    await dismissModal(page);
    return { result: 'weekly-limit', info };
  }
  if (await anyPresent(page, SEL.emailRequiredInput, 600)) {
    await dismissModal(page);
    return { result: 'email-required', info };
  }

  let noteSent = false;
  if (note) {
    const addNote = await firstVisible(page, SEL.addNoteButton, 2000);
    if (addNote) {
      await addNote.click();
      await sleep(randomBetween(500, 1000));
    }
    const ta = await firstVisible(page, SEL.noteTextarea, 2000);
    if (ta) {
      await typeLikeHuman(ta, note);
      await sleep(randomBetween(500, 1200));
      noteSent = true;
    } else {
      await snap(page, 'no-note-box');
      warn('note box not found (monthly personalised-invite limit?), sending without a note');
    }
  }

  const send = await firstVisible(page, SEL.sendInviteButton, 2500);
  if (!send) {
    await snap(page, 'no-send-button');
    await dismissModal(page);
    return { result: 'failed', info };
  }
  await send.click();
  await sleep(randomBetween(1200, 2200));
  await guard(page);

  if (await anyPresent(page, SEL.weeklyLimitText, 800)) {
    await snap(page, 'weekly-limit');
    await dismissModal(page);
    return { result: 'weekly-limit', info };
  }
  // confirm: the top card should now show Pending (or at least no Connect)
  const after = await topCardButtons(page, info.name);
  if (!after.pending && after.connect) {
    await snap(page, 'send-unconfirmed');
    return { result: 'failed', info };
  }
  return { result: 'sent', info, noteSent };
}

export async function dismissModal(page) {
  const d = await firstVisible(page, SEL.modalDismiss, 800);
  if (d) {
    await d.click().catch(() => {});
    await sleep(400);
  }
}

// Opens the message overlay from a profile and reads the thread.
// Returns { opened, reason?, info, editor?, lastFrom: 'them'|'me'|null, lastText }
// reason: 'not-connected' (Connect button shown) | 'no-message-button' | 'inmail' | 'no-editor'
export async function openThread(page, url, ownName, { clients } = {}) {
  const info = await openProfile(page, url);
  const client = clientOnProfile(info, clients);
  if (client) return { opened: false, info, reason: 'off-limits', client };
  if (!(await topCard(page, info.name))) { await snap(page, 'no-top-card'); await saveDom(page, 'no-top-card'); return { opened: false, info, reason: 'no-top-card' }; }
  if (!info.name) return { opened: false, info, reason: 'no-name' };   // cannot check whose thread opens
  const b = await topCardButtons(page, info.name);
  if (b.connect || b.pending || ['2nd', '3rd'].includes(info.degree)) return { opened: false, info, reason: 'not-connected' };
  if (!b.message) {
    await snap(page, 'no-message-button');
    return { opened: false, info, reason: 'no-message-button' };
  }
  // LinkedIn reopens old chat bubbles after a page load. Close them all first, so the only
  // message box on the page is this person's.
  await closeThread(page);
  const openEditors = () => page.locator(SEL.msgEditor.join(', ')).locator('visible=true').count();
  if (await openEditors()) {
    await snap(page, 'other-thread-open');
    return { opened: false, info, reason: 'other-thread-open' };
  }
  await b.message.click();
  await sleep(randomBetween(1500, 2600));
  await guard(page);
  if (await anyPresent(page, SEL.inmailMarker, 800)) {
    // InMail composer means we are not connected; never send InMails automatically
    await snap(page, 'inmail-composer');
    await closeThread(page);
    return { opened: false, info, reason: 'inmail' };
  }
  const editor = await firstVisible(page, SEL.msgEditor, 6000);
  if (!editor) {
    await snap(page, 'no-msg-editor');
    return { opened: false, info, reason: 'no-editor' };
  }
  if ((await openEditors()) > 1) {
    await snap(page, 'two-threads-open');
    await closeThread(page);
    return { opened: false, info, reason: 'other-thread-open' };
  }
  // everything below is read and clicked inside this person's chat bubble
  const bubble = page.locator(SEL.msgBubble.join(', ')).locator('visible=true').filter({ has: page.locator(SEL.msgEditor.join(', ')) }).first();
  const scope = (await bubble.count()) ? bubble : page;
  if (scope !== page) {
    const head = (await bubble.innerText().catch(() => '')).slice(0, 300);
    if (!head.toLowerCase().includes((info.firstName || info.name).toLowerCase())) {
      await snap(page, 'thread-name-mismatch');
      await closeThread(page);
      return { opened: false, info, reason: 'wrong-thread' };
    }
  }
  const thread = await readThread(scope, ownName);
  if (thread.unknown) {
    await snap(page, 'thread-not-loaded');
    await closeThread(page);
    return { opened: false, info, reason: 'thread-not-loaded' };
  }
  return { opened: true, info, editor, scope, ...thread };
}

export const sameText = (a, b) => String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim();

function sameName(a, b) {
  const n = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return n(a) && n(a) === n(b);
}

// Who spoke last in the open thread. Compares the full sender name with our own full name.
// `scope` is the chat bubble (or the page). Waits for the history to stop loading; if messages
// show but no sender names can be read, the answer is { unknown: true } and nothing is sent.
export async function readThread(scope, ownName, { settleMs = 4000 } = {}) {
  if (!ownName) throw new Error('own name unknown; cannot tell who spoke last');
  const read = async () => [
    await scope.locator(SEL.msgGroupName.join(', ')).allInnerTexts().catch(() => []),
    await scope.locator(SEL.msgBody.join(', ')).allInnerTexts().catch(() => []),
  ];
  let [names, bodies] = await read();
  for (let waited = 0, last = -1; waited < settleMs && (names.length + bodies.length) !== last; waited += 800) {
    last = names.length + bodies.length;
    await sleep(800);
    [names, bodies] = await read();
  }
  if (!names.length && bodies.length) return { unknown: true, lastFrom: null, lastText: '', count: 0, theySpoke: false };
  if (!names.length) return { lastFrom: null, lastText: '', count: 0, theySpoke: false };
  const lastName = names[names.length - 1].trim();
  const lastText = (bodies[bodies.length - 1] || '').trim();
  // Did they ever write in this thread? A reply that Kai has since answered by hand still counts.
  const theySpoke = names.some(n => !sameName(n, ownName));
  return { lastFrom: sameName(lastName, ownName) ? 'me' : 'them', lastText, count: names.length, lastName, theySpoke };
}

async function clearEditor(page, editor) {
  await editor.click();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+A`);
  await page.keyboard.press('Backspace');
  await sleep(200);
}

// Types and sends. Confirms by the editor emptying, or failing that by the thread now ending with our text.
export async function sendMessageInOpenThread(page, editor, text, ownName, scope = page) {
  await clearEditor(page, editor);      // LinkedIn keeps drafts; never append to one
  await typeLikeHuman(editor, text);
  await sleep(randomBetween(700, 1500));
  const send = await firstVisible(scope, SEL.msgSend, 3000);
  if (!send) {
    await snap(page, 'no-msg-send');
    await clearEditor(page, editor).catch(() => {});
    return false;
  }
  for (let i = 0; i < 6 && (await send.isDisabled().catch(() => false)); i++) await sleep(500);
  await send.click();
  await sleep(randomBetween(1500, 2500));
  await guard(page);
  const left = (await editor.innerText().catch(() => '')).trim();
  if (left.length === 0) return true;
  await sleep(3000);
  const t = await readThread(scope, ownName).catch(() => null);
  if (t && t.lastFrom === 'me' && sameText(t.lastText, text)) return true;
  await snap(page, 'send-unconfirmed');
  await clearEditor(page, editor).catch(() => {});   // leave no draft behind that a later pass could double-send
  return false;
}

// Closes every open chat bubble.
export async function closeThread(page) {
  for (let i = 0; i < 6; i++) {
    const c = await firstVisible(page, SEL.msgOverlayClose, i ? 500 : 1200);
    if (!c) break;
    await c.click().catch(() => {});
    await sleep(400);
  }
}

// Own display name, read once from /in/me/ and cached in the store's meta.
export async function readOwnName(page) {
  await goto(page, 'https://www.linkedin.com/in/me/');
  await sleep(1500);
  const name = (await textOf(page, SEL.profileName)).split('\n')[0].trim() || await nameFromTitle(page);
  if (!name) await saveDom(page, 'own-name-missing');
  if (!name) await snap(page, 'own-name-missing');
  log('own name', name || '(not found)');
  return name;
}

// People search: collects profile links from a results page.
export async function collectSearchResults(page, url, pageNo) {
  const u = new URL(url);
  u.searchParams.set('page', String(pageNo));
  await goto(page, u.toString());
  await humanScroll(page, { steps: 5 });
  const rows = await page.evaluate(() => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('main a[href*="/in/"]')) {
      const m = a.getAttribute('href').match(/\/in\/([^/?#]+)/);
      if (!m || seen.has(m[1])) continue;
      const li = a.closest('li') || a.closest('[data-chameleon-result-urn]') || a.closest('div[data-view-name]') || a.parentElement;
      const text = (li ? li.innerText : a.innerText).split('\n').map(s => s.trim()).filter(Boolean);
      // drop LinkedIn chrome like "View X's profile", "• 2nd", "Connect"
      const clean = text.filter(t => !/^(View .* profile|Connect|Message|Follow|• ?\d(st|nd|rd)|\d(st|nd|rd) degree connection|Premium)$/i.test(t) && !/^(Connect|Message)$/.test(t));
      const name = (a.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || clean[0] || '';
      const nameIdx = clean.findIndex(t => t === name);
      const rest = clean.filter((t, i) => i !== nameIdx && t !== name);
      seen.add(m[1]);
      const degreeLine = /^[•·]?\s*(1st|2nd|3rd\+?)$/i;
      const info = rest.filter(t => !degreeLine.test(t));
      const degree = ((name.match(/[•·]\s*(1st|2nd|3rd\+?)\s*$/i) || rest.find(t => degreeLine.test(t))?.match(degreeLine) || [])[1]) || '';
      out.push({ slug: m[1], name: name.replace(/\s*[•·]\s*(1st|2nd|3rd\+?)\s*$/i, '').trim(), degree, headline: info[0] || '', location: info[1] || '' });
    }
    return out;
  });
  const usable = rows.filter(r => r.name && !/^linkedin member$/i.test(r.name));
  if (!usable.length) await snap(page, `search-empty-p${pageNo}`);
  return usable;
}

// Turns a place name ("Dubai", "Switzerland") into LinkedIn's location id for the geoUrn filter.
// Tries LinkedIn's own typeahead first (same call the search box makes), then the Locations filter
// on the search page. Returns { id, name } or null. Never throws on "looks different".
export async function resolveGeo(page, name) {
  const wanted = String(name || '').trim();
  if (!wanted) return null;
  if (!/linkedin\.com/.test(page.url())) await goto(page, 'https://www.linkedin.com/search/results/people/?keywords=a');
  // 1. typeahead API, from inside the page so cookies and CSRF come along
  try {
    const hit = await page.evaluate(async (q) => {
      const m = document.cookie.match(/JSESSIONID="?([^";]+)/);
      const r = await fetch(`/voyager/api/typeahead/hitsV2?keywords=${encodeURIComponent(q)}&origin=OTHER&q=type&type=GEO`, {
        headers: { 'csrf-token': m ? m[1] : '', 'x-restli-protocol-version': '2.0.0', accept: 'application/vnd.linkedin.normalized+json+2.1' },
      });
      if (!r.ok) return null;
      const t = await r.text();
      const ids = [...t.matchAll(/urn:li:(?:fs_)?geo:(\d+)/g)].map(x => x[1]);
      const nm = t.match(/"text"\s*:\s*"([^"]{2,80})"/);
      return ids.length ? { id: ids[0], name: nm ? nm[1] : q } : null;
    }, wanted);
    if (hit) { log(`location "${wanted}" -> ${hit.name} (${hit.id})`); return hit; }
  } catch (e) { warn('location typeahead failed', e.message); }
  // 2. the Locations filter on the search page
  try {
    await goto(page, 'https://www.linkedin.com/search/results/people/?keywords=a');
    const btn = await firstVisible(page, SEL.locationsFilterButton, 4000);
    if (!btn) { await snap(page, 'no-locations-filter'); return null; }
    await btn.click();
    await sleep(randomBetween(600, 1200));
    const input = await firstVisible(page, SEL.locationsInput, 4000);
    if (!input) { await snap(page, 'no-locations-input'); return null; }
    await typeLikeHuman(input, wanted);
    await sleep(randomBetween(900, 1600));
    const opt = await firstVisible(page, SEL.locationsSuggestion, 5000);
    if (!opt) { await snap(page, 'no-location-suggestion'); return null; }
    const label = (await opt.innerText()).split('\n')[0].trim();
    await opt.click();
    await sleep(randomBetween(500, 1000));
    const show = await firstVisible(page, SEL.locationsShowResults, 4000);
    if (show) { await show.click(); await sleep(randomBetween(1500, 2500)); }
    const m = page.url().match(/geoUrn=%5B%22(\d+)%22|geoUrn=\[%22(\d+)|geoUrn=\["(\d+)/);
    const id = m && (m[1] || m[2] || m[3]);
    if (id) { log(`location "${wanted}" -> ${label} (${id})`); return { id, name: label || wanted }; }
    await snap(page, 'no-geo-in-url');
  } catch (e) { warn('location filter failed', e.message); }
  return null;
}
