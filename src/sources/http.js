// One polite HTTP client for every source. Each site asks for a user agent that says who we are,
// and several ask for about a request a second. Both are honoured here so no adapter can forget.
//
// The timeout covers reading the body as well as getting the headers, because a server that sends
// headers and then stalls would otherwise hang the whole run.
import { SOURCE_UA, contactSet } from '../paths.js';
import { warn } from '../log.js';

const nextSlot = new Map();
let warnedAboutContact = false;

// Reserve this source's turn before waiting, so callers running at the same time queue up behind
// each other instead of all reading the same timestamp and firing together.
function reserve(source, gapMs) {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(source) || 0);
  nextSlot.set(source, at + gapMs);
  return at - now;
}

export async function politeFetch(url, { source = 'sourcer', gapMs = 1100, timeoutMs = 20000, method = 'GET', body = null, headers = {}, fetchImpl = globalThis.fetch, allowHosts = null } = {}) {
  if (!contactSet() && !warnedAboutContact) {
    warnedAboutContact = true;
    warn('sources: SOURCER_CONTACT is not set, so these sites cannot see who is calling. Set it to your email address.');
  }
  const wait = reserve(source, gapMs);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method, body, signal: ctrl.signal, redirect: 'follow',
      headers: { 'user-agent': SOURCE_UA, accept: 'application/json', ...headers },
    });
    // A redirect can land somewhere we are not allowed to fetch. Check where we actually ended up.
    if (allowHosts && res.url) {
      let host = '';
      try { host = new URL(res.url).hostname; } catch { /* a fake response in a test has no url */ }
      if (host && !allowHosts.some(h => host === h || host.endsWith(`.${h}`))) {
        throw new Error(`${source}: redirected to ${host}, which is not a host we fetch from`);
      }
    }
    if (!res.ok) throw await describe(res, source);
    // Reading the body gets the rest of the same budget. Aborting the request is not enough on its
    // own: a body that never finishes would otherwise wait for ever.
    const left = () => Math.max(1000, timeoutMs - (Date.now() - started));
    const within = promise => Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => {
        ctrl.abort();
        const err = new Error(`${source}: sent headers then stalled`);
        err.timedOut = true;
        rej(err);
      }, left())),
    ]).finally(() => clearTimeout(timer));
    return { status: res.status, url: res.url, json: () => within(res.json()), text: () => within(res.text()) };
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') { const err = new Error(`${source}: no answer within ${Math.round(timeoutMs / 1000)}s`); err.timedOut = true; throw err; }
    throw e;
  }
}

// Tells a throttle apart from a refusal, because waiting fixes one and not the other.
async function describe(res, source) {
  const body = await res.text().catch(() => '');
  const secs = body.match(/more requests available in (\d+) seconds/)?.[1]
    || res.headers?.get?.('retry-after');
  const throttled = res.status === 429
    || /throttle_violation|rate limit exceeded|too many requests/i.test(body)
    || !!secs;
  if (throttled) {
    const err = new Error(secs ? `${source}: throttled, about ${Math.ceil(+secs / 60)} minutes left` : `${source}: throttled`);
    err.rateLimited = true;
    err.retryAfterMs = secs ? +secs * 1000 : null;
    return err;
  }
  // a 403 with no throttle wording is usually a bad key or a block, which waiting will not fix
  const err = new Error(`${source}: ${res.status}${body ? ` ${body.replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
  err.refused = res.status === 401 || res.status === 403;
  return err;
}

export const getJson = (url, opts = {}) => politeFetch(url, opts).then(r => r.json());
export const getText = (url, opts = {}) => politeFetch(url, opts).then(r => r.text());
