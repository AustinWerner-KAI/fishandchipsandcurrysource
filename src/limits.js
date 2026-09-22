// Daily caps, working hours and human-looking delays.

export const DEFAULT_CAPS = { connects: 15, messages: 25, profileViews: 60 };

export function startOfLocalDay(now = new Date(), timeZone = 'Asia/Dubai') {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now).reduce((o, p) => (o[p.type] = p.value, o), {});
  // find the UTC instant for local midnight by probing the offset at "now"
  const local = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  const offsetMin = tzOffsetMinutes(now, timeZone);
  return new Date(local.getTime() - offsetMin * 60000);
}

export function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(date).reduce((o, x) => (o[x.type] = x.value, o), {});
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

export function todayCount(store, type, now = new Date(), timeZone = 'Asia/Dubai') {
  return store.actionsSince(startOfLocalDay(now, timeZone).toISOString(), type).length;
}

export function remaining(store, caps, type, now = new Date(), timeZone = 'Asia/Dubai') {
  const cap = caps?.[type] ?? DEFAULT_CAPS[type] ?? 0;
  return Math.max(0, cap - todayCount(store, type, now, timeZone));
}

export function withinWorkingHours(hours, now = new Date()) {
  if (!hours) return true;
  const timeZone = hours.timezone || 'Asia/Dubai';
  const p = new Intl.DateTimeFormat('en-GB', { timeZone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' })
    .formatToParts(now).reduce((o, x) => (o[x.type] = x.value, o), {});
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const days = hours.days || [1, 2, 3, 4, 5];
  if (!days.includes(dayIndex)) return false;
  const mins = (+p.hour % 24) * 60 + (+p.minute);
  const [sh, sm] = (hours.start || '09:00').split(':').map(Number);
  const [eh, em] = (hours.end || '18:00').split(':').map(Number);
  return mins >= sh * 60 + sm && mins < eh * 60 + em;
}

// When the next working window opens, as a Date, or null if we are inside one now.
export function nextWorkingStart(hours, now = new Date()) {
  if (!hours || withinWorkingHours(hours, now)) return null;
  const t = new Date(now.getTime());
  t.setMinutes(Math.floor(t.getMinutes() / 15) * 15, 0, 0);   // walk on the quarter hour so 09:30 comes out as 09:30
  for (let i = 0; i < 8 * 24 * 4; i++) {          // quarter hours, a week ahead
    t.setTime(t.getTime() + 15 * 60000);
    if (withinWorkingHours(hours, t)) return t;
  }
  return null;
}

export function randomBetween(min, max, rng = Math.random) {
  return min + rng() * (max - min);
}

// Random pause between actions. Slightly skewed so most waits are near the low end,
// with the occasional long one, which is what a person browsing looks like.
export function humanPauseMs(rangeSec = [45, 180], rng = Math.random) {
  const [lo, hi] = rangeSec;
  const skew = Math.pow(rng(), 1.6);
  return Math.round((lo + skew * (hi - lo)) * 1000);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function pick(arr, rng = Math.random) {
  if (!arr || !arr.length) return undefined;
  return arr[Math.floor(rng() * arr.length)];
}
