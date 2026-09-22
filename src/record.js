// "Show me once": opens the logged-in browser, and while Kai clicks through a route (Recruiter search,
// a profile, the InMail box) it writes down every page, click and field, with a screenshot per step.
// Claude reads the recording and turns it into real automation steps.
//
// Never recorded: what is typed into password fields, or any typed text at all (only which field and
// how many characters). Close the browser window to finish.
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, saveSession } from './browser.js';
import { HOME } from './paths.js';
import { log } from './log.js';

const WATCH = () => {
  if (window.__srcRecOn) return;
  window.__srcRecOn = true;
  // Visible label text only. Never .value: that is what the person typed (passwords included).
  const txt = el => (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable || el.closest('[contenteditable=""], [contenteditable="true"], [role="textbox"]')) ? '' : (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const cssPath = el => {
    const out = [];
    for (let e = el; e && e.nodeType === 1 && out.length < 5; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id && !/\d{3,}/.test(e.id)) { s += '#' + e.id; out.unshift(s); break; }
      const cls = [...e.classList].filter(c => !/^ember|\d{3,}|^artdeco-button--\d/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.join('.');
      out.unshift(s);
    }
    return out.join(' > ');
  };
  const describe = el => {
    const t = el.closest('button, a, [role="button"], [role="option"], [role="tab"], [role="menuitem"], input, textarea, select, label, li') || el;
    const a = n => t.getAttribute(n) || undefined;
    return {
      tag: t.tagName.toLowerCase(), text: txt(t), ariaLabel: a('aria-label'), role: a('role'), id: t.id || undefined,
      name: a('name'), type: a('type'), placeholder: a('placeholder'), href: a('href'),
      dataTest: [...t.attributes].filter(x => /^data-(test|live-test|control-name|view-name)/.test(x.name)).map(x => `${x.name}=${x.value}`).slice(0, 3),
      css: cssPath(t),
    };
  };
  const send = ev => { try { window.__srcRec(ev); } catch {} };
  document.addEventListener('click', e => send({ kind: 'click', el: describe(e.target) }), true);
  document.addEventListener('change', e => {
    const t = e.target; if (!t || !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const secret = t.type === 'password' || /pass|pwd|otp|pin|code/i.test(t.name + t.id + (t.autocomplete || ''));
    const opt = t.tagName === 'SELECT' ? (t.selectedOptions[0]?.textContent || '').trim().slice(0, 60) : undefined;
    send({ kind: 'field', el: describe(t), chars: secret ? null : String(t.value || '').length, selected: secret ? undefined : opt, secret });
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Enter') send({ kind: 'enter', el: describe(e.target) }); }, true);
};

export async function recordRoute(name, startUrl, { maxMinutes = 20, onReady } = {}) {
  const safe = String(name || 'route').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'route';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(HOME, 'recordings', `${stamp}-${safe}`);
  fs.mkdirSync(dir, { recursive: true });
  const steps = [];
  let shot = 0, busy = false;
  const { context, page } = await openBrowser();
  const save = () => fs.writeFileSync(path.join(dir, 'route.json'), JSON.stringify({ name: safe, startUrl, recordedAt: stamp, steps }, null, 1));
  const snap = async (p, label) => {
    if (busy) return null; busy = true;
    try { const f = `${String(++shot).padStart(3, '0')}-${label}.png`; await p.screenshot({ path: path.join(dir, f) }); return f; }
    catch { return null; } finally { busy = false; }
  };
  await context.exposeBinding('__srcRec', async (src, ev) => {
    const step = { at: new Date().toISOString(), url: src.page.url(), ...ev };
    steps.push(step);
    log(`recorded ${ev.kind}: ${ev.el?.ariaLabel || ev.el?.text || ev.el?.placeholder || ev.el?.tag || ''}`.slice(0, 120));
    save();
    setTimeout(async () => { step.screenshot = await snap(src.page, ev.kind); save(); }, 700);
  });
  await context.addInitScript(WATCH);
  const onNav = p => p.on('framenavigated', f => { if (f === p.mainFrame()) { steps.push({ at: new Date().toISOString(), kind: 'page', url: f.url() }); save(); saveSession(context).catch(() => {}); setTimeout(async () => { const s = steps[steps.length - 1]; if (s.kind === 'page' && !s.screenshot) { s.screenshot = await snap(p, 'page'); save(); } }, 2500); } });
  context.pages().forEach(onNav);
  context.on('page', onNav);
  log(`recording "${safe}". Do the route in the browser window, then close the window to finish.`);
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.evaluate(WATCH).catch(() => {});
  if (onReady) onReady(context, page);            // tests drive the page from here
  const deadline = Date.now() + maxMinutes * 60000;
  while (Date.now() < deadline && context.pages().length) await new Promise(r => setTimeout(r, 1000));
  save();
  log(`recording saved: ${steps.length} steps in ${dir}`);
  if (context.pages().length) await saveSession(context).catch(() => {});
  await context.close().catch(() => {});
  return dir;
}
