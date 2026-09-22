// Profile-level operations. Each returns a plain result and never throws on "LinkedIn looks different",
// only on checkpoint / logged out (see browser.guard).
import { SEL, firstVisible, anyPresent } from './selectors.js';
import { goto, humanScroll, snap, typeLikeHuman } from './browser.js';
import { sleep, randomBetween } from './limits.js';
import { log, warn } from './log.js';
import { normalizeUrl, firstNameOf } from './store.js';

async function textOf(page, candidates) {
  const loc = await firstVisible(page, candidates, 1500);
  if (!loc) return '';
  return (await loc.innerText()).trim();
}

export async function readProfile(page) {
  const name = await textOf(page, SEL.profileName);
  const headline = await textOf(page, SEL.profileHeadline);
  const degreeRaw = await textOf(page, SEL.profileDegree);
  const degree = (degreeRaw.match(/1st|2nd|3rd/) || [''])[0];
  return { name, firstName: firstNameOf(name), headline, degree };
}

export async function openProfile(page, url) {
  await goto(page, normalizeUrl(url) || url);
  await humanScroll(page, { steps: 2 });
  const info = await readProfile(page);
  return info;
}

// Returns one of: 'sent' | 'already-connected' | 'pending' | 'no-button' | 'weekly-limit' | 'email-required' | 'failed'
export async function sendConnectionRequest(page, url, note) {
  const info = await openProfile(page, url);
  if (info.degree === '1st') return { result: 'already-connected', info };
  if (await anyPresent(page, SEL.pendingButton, 800)) return { result: 'pending', info };

  let btn = await firstVisible(page, SEL.connectButton, 1500);
  if (!btn) {
    const more = await firstVisible(page, SEL.moreActionsButton, 1500);
    if (more) {
      await more.click();
      await sleep(randomBetween(600, 1200));
      btn = await firstVisible(page, SEL.moreMenuConnect, 1500);
    }
  }
  if (!btn) {
    await snap(page, 'no-connect-button');
    return { result: 'no-button', info };
  }
  await btn.click();
  await sleep(randomBetween(900, 1800));

  if (await anyPresent(page, SEL.weeklyLimitText, 1000)) {
    await snap(page, 'weekly-limit');
    await dismissModal(page);
    return { result: 'weekly-limit', info };
  }
  if (await anyPresent(page, SEL.emailRequiredInput, 600)) {
    await dismissModal(page);
    return { result: 'email-required', info };
  }

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
    } else {
      warn('note box not found, sending without a note');
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

  if (await anyPresent(page, SEL.weeklyLimitText, 800)) {
    await snap(page, 'weekly-limit');
    await dismissModal(page);
    return { result: 'weekly-limit', info };
  }
  // confirm: the Connect button should now read Pending (or be gone)
  const pending = await anyPresent(page, SEL.pendingButton, 2500);
  const stillConnect = await anyPresent(page, SEL.connectButton, 500);
  if (!pending && stillConnect) {
    await snap(page, 'send-unconfirmed');
    return { result: 'failed', info };
  }
  return { result: 'sent', info };
}

export async function dismissModal(page) {
  const d = await firstVisible(page, SEL.modalDismiss, 800);
  if (d) {
    await d.click().catch(() => {});
    await sleep(400);
  }
}

// Opens the message overlay from a profile and reads the thread.
// Returns { opened, lastFrom: 'them'|'me'|null, lastText, ownName }
export async function openThread(page, url, ownName) {
  const info = await openProfile(page, url);
  if (info.degree !== '1st') return { opened: false, info, reason: 'not-connected' };
  const btn = await firstVisible(page, SEL.messageButton, 2000);
  if (!btn) return { opened: false, info, reason: 'no-message-button' };
  await btn.click();
  await sleep(randomBetween(1500, 2600));
  const editor = await firstVisible(page, SEL.msgEditor, 6000);
  if (!editor) {
    await snap(page, 'no-msg-editor');
    return { opened: false, info, reason: 'no-editor' };
  }
  const thread = await readThread(page, ownName);
  return { opened: true, info, editor, ...thread };
}

export async function readThread(page, ownName) {
  const names = await page.locator(SEL.msgGroupName[0]).allInnerTexts().catch(() => []);
  const bodies = await page.locator(SEL.msgBody[0]).allInnerTexts().catch(() => []);
  if (!names.length) return { lastFrom: null, lastText: '', count: 0 };
  const lastName = names[names.length - 1].trim();
  const lastText = (bodies[bodies.length - 1] || '').trim();
  const me = ownName && lastName.toLowerCase().startsWith(ownName.split(' ')[0].toLowerCase());
  return { lastFrom: me ? 'me' : 'them', lastText, count: names.length, lastName };
}

export async function sendMessageInOpenThread(page, editor, text) {
  await typeLikeHuman(editor, text);
  await sleep(randomBetween(700, 1500));
  const send = await firstVisible(page, SEL.msgSend, 3000);
  if (!send) {
    await snap(page, 'no-msg-send');
    return false;
  }
  if (await send.isDisabled().catch(() => false)) {
    await sleep(800);
  }
  await send.click();
  await sleep(randomBetween(1500, 2500));
  // sent if the editor is empty again
  const left = (await editor.innerText().catch(() => '')).trim();
  return left.length === 0;
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
      out.push({ slug: m[1], name, headline: rest[0] || '', location: rest[1] || '' });
    }
    return out;
  });
  return rows.filter(r => r.name && !/^linkedin member$/i.test(r.name));
}
