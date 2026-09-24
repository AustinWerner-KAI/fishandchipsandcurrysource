// When LinkedIn moves a control, Sourcer stops and asks Kai which one it is, in the Sourcer page.
//
// Three things make that work without him ever touching the browser window:
//   1. everything the page can be clicked on is read out and stored, with a picture, so the
//      question survives the browser closing and can be answered hours later;
//   2. his answer becomes a list of ways to find that control again, best first;
//   3. a learned way is not trusted until a real action using it has been confirmed by LinkedIn.
import fs from 'node:fs';
import path from 'node:path';
import { SCREENSHOT_DIR, ensureDirs } from './paths.js';
import { cssStr } from './selectors.js';
import { log, warn } from './log.js';

// ---- what the page offers ----

// Reads every control a person could click, from inside the dialog when there is one. Runs in the
// page, so it sees what LinkedIn actually rendered rather than what we hoped for.
// The window we are working in. Defined once: when the read and the lookup disagree about which
// window that is, Sourcer shows Kai a control it will then never look at, and asks for ever.
export const DIALOG = '[role="dialog"], .artdeco-modal';

export const READ_CANDIDATES = `(() => {
  // A second read on the same page would otherwise leave the first read's numbers behind, and a
  // badge would land on the wrong element.
  for (const old of document.querySelectorAll('[data-sourcer-candidate]')) old.removeAttribute('data-sourcer-candidate');
  // the last one, because a newly opened window is appended after any older one still on the page
  const dialogs = [...document.querySelectorAll('${DIALOG}')].filter(d => d.getClientRects().length);
  const dialog = dialogs[dialogs.length - 1] || null;
  const scope = dialog || document.querySelector('main') || document.body;
  const sel = 'button, [role="button"], input:not([type="hidden"]), textarea, [role="textbox"], [contenteditable="true"], a[href]';
  const seen = [];
  let n = 0;
  for (const el of scope.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || +style.opacity === 0) continue;
    if (el.disabled) continue;
    const tidy = v => String(v || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    // What it says on screen and what it says to a screen reader are different things. The words
    // are what Kai will recognise in the picture; the label is often the better way to find it.
    // What is inside a box is the note Kai wrote, and sometimes a candidate's own words. It is not
    // needed to find the box again, so it is never read out or stored.
    const typable = el.matches('textarea, input, [contenteditable="true"], [role="textbox"]');
    const text = typable ? tidy(el.placeholder) : tidy(el.innerText || el.value);
    const label = tidy(el.getAttribute('aria-label') || el.title);
    const name = text || label;
    if (!name && !typable) continue;
    n += 1;
    el.setAttribute('data-sourcer-candidate', String(n));
    const data = {};
    for (const a of el.attributes) if (/^data-(test|live-test|control)/.test(a.name)) data[a.name] = a.value;
    seen.push({
      n, name, text, label,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || (el.tagName === 'BUTTON' ? 'button' : ''),
      type: el.getAttribute('type') || '',
      // ember123 and the like are generated fresh on every load, so they are no use to us
      id: /^[A-Za-z][\\w-]{2,40}$/.test(el.id || '') && !/^(ember|react|radix|headlessui|:r)/i.test(el.id) && !/\\d{4,}/.test(el.id) ? el.id : '',
      data,
      typable,
      // roughly: is this the one the eye goes to
      primary: /artdeco-button--primary|primary/.test(el.className || ''),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
    // Read generously and let the ordering decide what Kai is shown. Stopping at the first
    // handful in page order would cut the Send button off the bottom of the list whenever the
    // window did not open and the whole profile had to be read instead.
    if (seen.length >= 60) break;
  }
  return { inDialog: !!dialog, candidates: seen };
})()`;

// The one most likely to be what we lost, first. A primary button inside a dialog usually is.
export function orderCandidates(list = [], { want = '', limit = 0 } = {}) {
  const wants = String(want || '').toLowerCase();
  const score = c => {
    let s = 0;
    if (c.primary) s += 30;
    if (c.role === 'button' || c.tag === 'button') s += 20;
    if (Object.keys(c.data || {}).length) s += 10;
    if (wants && c.name && wants.includes(c.name.toLowerCase().split(' ')[0])) s += 25;
    if (/^(send|invite|connect|submit|done)\b/i.test(c.name || '')) s += 25;
    // Cancel is never the control we lost, so it goes below everything, not just below buttons
    if (/^(cancel|dismiss|close|back|not now|skip)\b/i.test(c.name || '')) s -= 100;
    return s;
  };
  const sorted = [...list].sort((a, b) => score(b) - score(a) || a.n - b.n);
  // A long list is worse than a short one: the best few are what Kai can actually read against
  // the picture. Cut after scoring, never before, or the right control goes over the edge.
  return (limit > 0 ? sorted.slice(0, limit) : sorted)
    // `n` is where it sits in the page, `pos` is where it sits in the list Kai reads. The picture
    // is numbered by `pos` too, or the two would disagree and he would pick the wrong one.
    .map((c, i) => ({ ...c, pos: i + 1 }));
}

// Outlines and numbers the choices on the page itself, so the picture Kai sees matches his list.
export const badgeScript = ordered => `(() => {
  const byPos = ${JSON.stringify(ordered.map(c => [c.n, c.pos]))};
  const old = document.getElementById('sourcer-badges');
  if (old) old.remove();
  const style = document.createElement('style');
  style.id = 'sourcer-badges';
  style.textContent = '[data-sourcer-candidate]{outline:2px dashed #1f4fd8 !important;outline-offset:3px !important}'
    + '.sourcer-badge{position:absolute;z-index:2147483647;width:20px;height:20px;border-radius:50%;background:#1f4fd8;'
    + 'color:#fff;font:700 12px/20px -apple-system,system-ui,sans-serif;text-align:center;pointer-events:none;'
    + 'box-shadow:0 1px 3px rgba(0,0,0,.35)}';
  document.head.appendChild(style);
  for (const [n, pos] of byPos) {
    const el = document.querySelector('[data-sourcer-candidate="' + n + '"]');
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const b = document.createElement('div');
    b.className = 'sourcer-badge';
    b.textContent = String(pos);
    b.style.left = Math.max(2, r.left + scrollX - 10) + 'px';
    b.style.top = Math.max(2, r.top + scrollY - 10) + 'px';
    document.body.appendChild(b);
  }
  return byPos.length;
})()`;

// ---- turning a choice into something we can find again ----

// LinkedIn puts the person's name inside labels ("Invite Ada Lovelace to connect"). Left as it is,
// a learned selector would work once and never again, so the name goes back to a placeholder.
export function templatise(text, name = '') {
  const full = String(name || '').trim();
  if (!full) return text;
  const first = full.split(/\s+/)[0];
  // Whole words only. Otherwise "Grace Hopper" turns "Grace period reminder" into a selector that
  // matches nobody, and the learned control dies quietly.
  const swap = (s, find, token) => {
    if (!find) return s;
    const esc = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return s.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?=[^\\p{L}\\p{N}]|$)`, 'gu'), `$1${token}`);
  };
  // the full name first, so "Ada Lovelace" does not become "{firstName} Lovelace"
  return swap(swap(String(text), full, '{name}'), first, '{firstName}');
}

// A selector still carrying a placeholder cannot be used for somebody whose name we do not have.
const HAS_TOKEN = /\{(name|firstName)\}/;

const quote = v => `"${cssStr(v)}"`;

// Only an attribute name that looks like an attribute name. "data-x],button[aria-label" does not.
const SAFE_ATTR = /^[A-Za-z][A-Za-z0-9_-]*$/;

// ember123, :r4:, react-aria-17 and anything with a long number in it are generated fresh on
// every page load. Checked in both places on purpose: the page may not be the one that read it.
export const stableId = id =>
  /^[A-Za-z][\w-]{2,40}$/.test(String(id || '')) && !/^(ember|react|radix|headlessui|:r)/i.test(id) && !/\d{4,}/.test(id);

// Several ways to find it, best first. Their own test attributes are the most stable thing on the
// page; a visible label is next; an id is a last resort because LinkedIn generates them.
// `inDialog` is not a detail. A selector learned inside the invite window is only ever looked for
// inside that window, so an exact "Send" there is safe. Learned off the open page, the same
// selector is looked for across the whole profile, where "Send" and a bare `textarea` can be
// anything at all. So when the window was not open, only the durable, self-identifying selectors
// are kept, and if the control carries none of those, nothing is learned from it.
export function selectorsFor(candidate, { name = '', inDialog = true } = {}) {
  if (!candidate) return [];
  const out = [];
  const tag = candidate.tag === 'a' ? 'a' : (candidate.tag || '*');
  for (const [k, v] of Object.entries(candidate.data || {})) if (SAFE_ATTR.test(k)) out.push(`[${k}=${quote(v)}]`);

  // the screen-reader label first: it survives a copy change more often than the visible words
  const label = candidate.label ? templatise(candidate.label, name) : '';
  if (label) out.push(`${tag}[aria-label=${quote(label)}]`);

  if (candidate.typable) {
    // What READ_CANDIDATES reports for a box is its placeholder, which is an attribute and not
    // text content, so :text-is would never match it.
    const ph = templatise(candidate.text || '', name);
    if (ph && !HAS_TOKEN.test(ph)) out.push(`${tag}[placeholder=${quote(ph)}]`);
  } else if (inDialog) {
    // :text-is is an exact match. :has-text is a substring, so "Send" would also match
    // "Send message" and "Resend" elsewhere on the page, which is how the wrong button gets clicked.
    // Learned selectors are only ever searched inside the one window, so a short word like "OK"
    // is safe here in a way it would not be across a whole page.
    const words = templatise(candidate.text || '', name);
    // No length limit worth having: an exact match on long text inside one window is still exact,
    // and the read already caps what it collects.
    if (words && !HAS_TOKEN.test(words)) {
      out.push(`${tag}:text-is(${quote(words)})`);
    }
  }

  // An id we believe in comes next. No selector is ever invented out of text we did not see in a
  // label: asserting an aria-label that was not there matches whatever else happens to carry it.
  if (stableId(candidate.id)) out.push(`#${candidate.id}`);
  // Inside the one window a box can always fall back to "the box". Across a whole page it cannot:
  // `textarea` would match a comment box three sections down.
  if (candidate.typable && inDialog) out.push(`${tag}`, '[role="textbox"]', 'textarea');
  return [...new Set(out)];
}

// ---- the question, and what was learned from it ----

// Safe with no store at all: several callers work with or without one.
const meta = store => (store?.data ? (store.data.meta ||= {}) : {});

export function askFor(store, { step, lane, why, lead = {}, shot = '', candidates = [], want = '', inDialog = false }) {
  // One question at a time. Overwriting the first would lose it before Kai ever saw it.
  const already = pendingQuestion(store);
  if (already && already.step !== step) {
    log(`already waiting on "${already.step}", so "${step}" is not asked as well`);
    return already;
  }
  meta(store).healQuestion = {
    inDialog,
    step, lane, why,
    lead: { url: lead.url || '', name: lead.name || '' },
    shot, want,
    candidates: orderCandidates(candidates, { want }),
    at: new Date().toISOString(),
  };
  return meta(store).healQuestion;
}

export const pendingQuestion = store => meta(store).healQuestion || null;

// Kai picked one. Store the ways to find it, unproven until something works with it.
export function answer(store, n) {
  const q = pendingQuestion(store);
  if (!q) return { ok: false, problem: 'nothing is waiting to be answered' };
  if (n === null || n === undefined || n === 'none') {
    // "None of these" is not "forget it". The page Sourcer read, and the picture it took, are the
    // only record of what LinkedIn changed, so they are kept for Claude to look at instead of
    // being dropped along with the question.
    meta(store).healUnsolved = { ...q, skippedAt: new Date().toISOString() };
    meta(store).healQuestion = undefined;
    return { ok: true, skipped: true };
  }
  const picked = (q.candidates || []).find(c => String(c.n) === String(n));
  if (!picked) return { ok: false, problem: 'that is not one of the choices' };
  const selectors = selectorsFor(picked, { name: q.lead?.name, inDialog: !!q.inDialog });
  if (!selectors.length) {
    return { ok: false, problem: q.inDialog
      ? 'there is no reliable way to find that one again'
      : 'the invitation window was not open when this was read, so that one cannot be found again safely. Leave it paused.' };
  }
  meta(store).learned = { ...(meta(store).learned || {}) };
  meta(store).learned[q.step] = {
    step: q.step, lane: q.lane, selectors,
    // the name with the person taken out of it, so a record does not keep who it was learned from
    chose: templatise(picked.name || `#${picked.n}`, q.lead?.name),
    inDialog: !!q.inDialog,
    verified: false, at: new Date().toISOString(),
  };
  meta(store).healQuestion = undefined;
  log(`learned a new way to find "${q.step}": ${selectors[0]}`);
  return { ok: true, step: q.step, selectors, chose: picked.name };
}

export const learnedFor = (store, step) => meta(store).learned?.[step] || null;

// Everything a lane learned but has not proved yet.
export const unproven = (store, lane) =>
  Object.values(meta(store).learned || {}).filter(l => !l.verified && (!lane || l.lane === lane));

// Only the steps this action actually went through. A send that carried no note proves nothing
// about the note box, and confirming it would make a wrong choice permanent.
export function confirmSteps(store, steps = []) {
  const l = meta(store).learned || {};
  let n = 0;
  for (const step of steps) {
    if (l[step] && !l[step].verified) { l[step] = { ...l[step], verified: true, verifiedAt: new Date().toISOString() }; n++; }
  }
  if (n) log(`${n} learned ${n === 1 ? 'control' : 'controls'} confirmed working`);
  return n;
}

// Kai looked at what was learned and said no. Used from the dashboard, so a wrong choice is never
// something only a text editor can undo.
export function forget(store, step) {
  const l = meta(store).learned || {};
  if (!l[step]) return { ok: false, problem: 'nothing was learned for that one' };
  const gone = l[step];
  delete l[step];
  meta(store).learned = { ...l };
  warn(`forgetting the learned control for "${step}"`);
  return { ok: true, step, chose: gone.chose || '' };
}

export function discardLane(store, lane) {
  const l = meta(store).learned || {};
  let n = 0;
  for (const k of Object.keys(l)) {
    if (l[k].lane === lane && !l[k].verified) { delete l[k]; n++; }
  }
  if (n) warn(`${n} unproven learned ${n === 1 ? 'control' : 'controls'} did not work, forgetting ${n === 1 ? 'it' : 'them'}`);
  return n;
}

// ---- health, one lane at a time ----

export function laneDown(store, lane, problem) {
  meta(store).health = { ...(meta(store).health || {}), [lane]: { problem, at: new Date().toISOString() } };
}
export function laneUp(store, lane) {
  const h = { ...(meta(store).health || {}) };
  delete h[lane];
  meta(store).health = h;
}
export function laneIsDown(store, lane, withinMs = 60 * 60000) {
  const h = meta(store).health?.[lane];
  if (!h?.at) return false;
  const age = Date.now() - new Date(h.at).getTime();
  // an unreadable timestamp is treated as a problem, not as healthy
  return Number.isNaN(age) ? true : age < withinMs;
}

// ---- the picture ----

export async function shotFor(page, label) {
  try {
    ensureDirs();
    const file = `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.png`;
    // Boxes are blanked out. The picture is there to show which control is which, and the note Kai
    // wrote is nobody else's business.
    const mask = page.locator ? [page.locator('textarea, input, [contenteditable="true"], [role="textbox"]')] : [];
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, file), fullPage: false, mask, maskColor: '#c9ced6' });
    pruneShots();
    return file;
  } catch (e) { warn('could not take a picture of the page:', e.message); return ''; }
}

// These are pictures of a logged-in LinkedIn page. Keep the last handful, not every one ever taken.
export function pruneShots(keep = 20) {
  try {
    const files = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      fs.rmSync(path.join(SCREENSHOT_DIR, f), { force: true });
    }
  } catch { /* nothing to prune */ }
}

export const shotPath = file => path.join(SCREENSHOT_DIR, path.basename(String(file || '')));
export const shotExists = file => !!file && fs.existsSync(shotPath(file));

// ---- finding a control ----

// Tries what we learned before the list we shipped with, because a learned one came from this
// page as it is today. `{name}` in a learned selector is filled in for this person.
export function candidatesFor(store, step, shipped = [], { name = '' } = {}) {
  const learned = learnedFor(store, step);
  const full = cssStr(String(name || '').trim());
  const first = cssStr(String(name || '').trim().split(/\s+/)[0] || '');
  const fill = sel => String(sel).split('{name}').join(full).split('{firstName}').join(first);
  // A selector that still needs a name we do not have would match the wrong thing, so it is dropped
  const usable = sel => !!name || !HAS_TOKEN.test(sel);
  const mine = (learned?.selectors || []).filter(usable).map(fill);
  return [...mine, ...shipped.filter(usable).map(fill)];
}

// Like firstVisible, but a selector matching more than one thing is passed over rather than
// resolved to the first. Used only where the search is not confined to the invitation window.
async function onlyVisible(scope, selectors, timeout) {
  for (const sel of selectors) {
    try {
      const all = scope.locator(sel);
      const one = all.first();
      await one.waitFor({ state: 'visible', timeout });
      const n = await all.count();
      if (n !== 1) { warn(`"${sel}" matches ${n} things on this page, so it is not used`); continue; }
      return one;
    } catch { /* try the next one */ }
  }
  return null;
}

// Everything a step needs to find its control, ask about it, and say which lane it belongs to.
// Returns { el, viaLearned, asked }.
//   el          the control, or null
//   viaLearned  it was found by something we learned, not by a selector we shipped with. Only then
//               does a confirmed action prove anything about what was learned.
//   asked       a question was put to Kai. The caller must not carry on as if nothing happened.
export async function findOrAsk(scope, { page, store, step, lane, shipped, name = '', want = '', why, timeout = 2500, firstVisible }) {
  const learned = learnedFor(store, step);
  const mine = candidatesFor(store, step, [], { name });
  const theirs = candidatesFor(store, step, shipped, { name }).slice(mine.length);

  // A control learned from inside the invite window is looked for inside the invite window, and
  // nowhere else. Searching the whole page is how an exact "Send" ends up clicking something on
  // the profile behind it, which is the bug this whole feature exists to avoid causing.
  if (mine.length) {
    // entries from before this field existed came from a dialog too, so the cautious reading wins
    const scoped = learned?.inDialog !== false && page?.locator;
    const where = scoped ? page.locator(DIALOG).last() : scope;
    // Inside the one window, the first match is the match. Learned off the open page, it has to be
    // the only thing on that page answering to it: two matches and we cannot know which is ours,
    // and a guess here is a click on somebody's real profile.
    const el = scoped ? await firstVisible(where, mine, timeout) : await onlyVisible(where, mine, timeout);
    if (el) return { el, viaLearned: true, asked: false };
  }
  const el = await firstVisible(scope, theirs, timeout);
  if (el) return { el, viaLearned: false, asked: false };

  // nothing matched: read the page out, take a picture, and put the question in front of Kai
  let read = { candidates: [] };
  try { read = await page.evaluate(READ_CANDIDATES); } catch (e) { warn(`could not read the page for "${step}":`, e.message); }
  const ordered = orderCandidates(read.candidates, { want, limit: 12 });
  const inDialog = !!read.inDialog;
  try { if (ordered.length) await page.evaluate(badgeScript(ordered)); } catch { /* the picture is still useful without them */ }
  const shot = await shotFor(page, step);
  store.refresh();
  const q = askFor(store, { step, lane, why: why || `could not find ${step}`, lead: { name }, shot, candidates: ordered, want, inDialog });
  const asked = q?.step === step;
  if (asked) laneDown(store, lane, why || `waiting for you to say which control is ${step}`);
  store.save();
  warn(asked
    ? `${step}: not on the page. Asked Kai, with ${ordered.length} ${ordered.length === 1 ? 'choice' : 'choices'}.`
    : `${step}: not on the page, and Kai is already being asked about "${q?.step}".`);
  return { el: null, viaLearned: false, asked };
}
