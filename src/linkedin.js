// Profile-level operations. Each returns a plain result and never throws on "LinkedIn looks different",
// only on checkpoint / logged out (see browser.guard).
//
// Every action button is looked up inside the profile's top card AND by the person's name
// ("Invite Jane Doe to connect"), so a suggested-people card further down the page is never clicked.
import { SEL, firstVisible, anyPresent, withName } from './selectors.js';
import { goto, guard, humanScroll, snap, typeLikeHuman } from './browser.js';
import { sleep, randomBetween } from './limits.js';
import { log, warn } from './log.js';
import { normalizeUrl, firstNameOf } from './store.js';

async function textOf(scope, candidates) {
  const loc = await firstVisible(scope, candidates, 1500);
  if (!loc) return '';
  return (await loc.innerText()).trim();
}

async function topCard(page) {
  return (await firstVisible(page, SEL.topCard, 2500)) || page.locator('main');
}

export async function readProfile(page) {
  const name = await textOf(page, SEL.profileName);
  const headline = await textOf(page, SEL.profileHeadline);
  const degreeRaw = await textOf(page, SEL.profileDegree);
  const degree = (degreeRaw.match(/\b(1st|2nd|3rd)\b/) || [''])[0];
  return { name, firstName: firstNameOf(name), headline, degree };
}

export async function openProfile(page, url) {
  await goto(page, normalizeUrl(url) || url);
  await humanScroll(page, { steps: 2 });
  const info = await readProfile(page);
  if (!info.name) {
    await snap(page, 'no-profile-name');
    warn('could not read the profile name; buttons will only be matched inside the top card');
  }
  return info;
}

// What the top card offers for this person.
async function topCardButtons(page, name) {
  const card = await topCard(page);
  const connect = await firstVisible(card, withName(SEL.connectButton, name), 1200);
  const pending = await firstVisible(card, SEL.pendingButton, 600);
  const message = await firstVisible(card, withName(SEL.messageButton, name), 800);
  const more = await firstVisible(card, SEL.moreActionsButton, 600);
  return { card, connect, pending, message, more };
}

// Returns one of: 'sent' | 'already-connected' | 'pending' | 'no-button' | 'weekly-limit' | 'email-required' | 'failed'
export async function sendConnectionRequest(page, url, note) {
  const info = await openProfile(page, url);
  const b = await topCardButtons(page, info.name);
  if (info.degree === '1st') return { result: 'already-connected', info };
  if (b.pending) return { result: 'pending', info };

  let btn = b.connect;
  if (!btn && b.more) {
    await b.more.click();
    await sleep(randomBetween(600, 1200));
    btn = await firstVisible(page, withName(SEL.moreMenuConnect, info.name), 1500);
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
export async function openThread(page, url, ownName) {
  const info = await openProfile(page, url);
  const b = await topCardButtons(page, info.name);
  if (b.connect || b.pending || ['2nd', '3rd'].includes(info.degree)) return { opened: false, info, reason: 'not-connected' };
  if (!b.message) {
    await snap(page, 'no-message-button');
    return { opened: false, info, reason: 'no-message-button' };
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
  const thread = await readThread(page, ownName);
  return { opened: true, info, editor, ...thread };
}

function sameName(a, b) {
  const n = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return n(a) && n(a) === n(b);
}

// Who spoke last in the open thread. Compares the full sender name with our own full name.
export async function readThread(page, ownName) {
  if (!ownName) throw new Error('own name unknown; cannot tell who spoke last');
  const names = await page.locator(SEL.msgGroupName.join(', ')).allInnerTexts().catch(() => []);
  const bodies = await page.locator(SEL.msgBody.join(', ')).allInnerTexts().catch(() => []);
  if (!names.length) return { lastFrom: null, lastText: '', count: 0 };
  const lastName = names[names.length - 1].trim();
  const lastText = (bodies[bodies.length - 1] || '').trim();
  return { lastFrom: sameName(lastName, ownName) ? 'me' : 'them', lastText, count: names.length, lastName };
}

async function clearEditor(page, editor) {
  await editor.click();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+A`);
  await page.keyboard.press('Backspace');
  await sleep(200);
}

// Types and sends. Confirms by the editor emptying, or failing that by the thread now ending with our text.
export async function sendMessageInOpenThread(page, editor, text, ownName) {
  await clearEditor(page, editor);      // LinkedIn keeps drafts; never append to one
  await typeLikeHuman(editor, text);
  await sleep(randomBetween(700, 1500));
  const send = await firstVisible(page, SEL.msgSend, 3000);
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
  const t = await readThread(page, ownName).catch(() => null);
  if (t && t.lastFrom === 'me' && t.lastText === text.trim()) return true;
  await snap(page, 'send-unconfirmed');
  await clearEditor(page, editor).catch(() => {});   // leave no draft behind that a later pass could double-send
  return false;
}

export async function closeThread(page) {
  const c = await firstVisible(page, SEL.msgOverlayClose, 1200);
  if (c) await c.click().catch(() => {});
  await sleep(400);
}

// Own display name, read once from /in/me/ and cached in the store's meta.
export async function readOwnName(page) {
  await goto(page, 'https://www.linkedin.com/in/me/');
  const name = await textOf(page, SEL.profileName);
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
