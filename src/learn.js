// The learning loop. Sourcer learns, per role, from three things:
//   1. Kai's own picks: approved people are good examples, people he excluded are bad ones,
//      and people he passed over while ticking lower-ranked ones count a little against.
//   2. Results: an accepted invite counts more, a reply counts most, and an invite ignored
//      for 3 weeks counts against.
//   3. Wording: when a role has more than one connection note, the one that gets accepted
//      most is used most (the others are still tried now and then).
// Everything is plain counting, and every point it adds or takes away comes with a reason
// Kai can read ("you pick: azure").
import { cleanLead, scoreLead } from './rank.js';
import { offLimits } from './offlimits.js';

const DAY = 86400000;
const STOP = new Set(('a an and at for of the to in on with by from as or & | - at @ ex former current currently ' +
  'i am my me we our is are be team teams company group based new york united states area city metropolitan ' +
  'looking open work working experience years year professional passionate helping help').split(' '));

// Words and two-word phrases from the job part of a headline ("Senior Cloud Security Engineer | Azure").
export function features(lead) {
  const { headline, degree } = cleanLead(lead);
  const out = new Set();
  // phrases stay inside one part of the headline: "Engineer | Azure" is not "engineer azure"
  // accents dropped first, so "Ingénieur" is one word, not "ing" and "nieur"
  for (const part of String(headline || '').normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().split(/[|•·,/;()]+|\s[-–]\s|\sat\s|@/)) {
    const words = part.replace(/[^a-z0-9+#. ]+/g, ' ').split(/\s+/)
      .map(w => w.replace(/^\.+|\.+$/g, '')).filter(w => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
    for (const w of words) out.add(w);
    for (let i = 0; i < words.length - 1; i++) out.add(`${words[i]} ${words[i + 1]}`);
  }
  if (degree) out.add(`degree:${degree}`);
  return [...out];
}

// Who teaches what, and how strongly. Returns [{ lead, w }] with w > 0 good, w < 0 bad.
export function examples(leads, role, now = Date.now(), clients = []) {
  const out = [];
  const approvedScores = [];
  for (const l of leads) {
    // only Kai's own decisions and real results teach: not automatic skips, not people at clients
    if (l.offLimits || l.autoSkip || (clients.length && offLimits(l, clients)) || (l.status === 'skipped' && !l.skippedByHand)) continue;
    const accepted = l.acceptedAt || ['accepted', 'messaged', 'replied', 'done'].includes(l.status);
    if (l.status === 'replied') out.push({ lead: l, w: 3 });
    else if (accepted && !l.preexisting) out.push({ lead: l, w: 2 });
    else if (l.status === 'invited' && l.invitedAt && now - new Date(l.invitedAt) > 21 * DAY) out.push({ lead: l, w: -0.5 });
    else if (l.status === 'invited' || (l.status === 'new' && l.approved)) out.push({ lead: l, w: 1 });
    else if (l.status === 'skipped' && l.skippedByHand) out.push({ lead: l, w: -1 });
    if (l.status === 'new' && l.approved) approvedScores.push(scoreLead(l, role).score ?? 0);
  }
  // passed over: ranked above the median person Kai ticked, yet left unticked
  if (approvedScores.length >= 5) {
    const median = approvedScores.sort((a, b) => a - b)[Math.floor(approvedScores.length / 2)];
    for (const l of leads) {
      // 1st connections and people at clients cannot be ticked, so they were never passed over
      if (l.status === 'new' && !l.approved && !l.offLimits && cleanLead(l).degree !== '1st' && !(clients.length && offLimits(l, clients))
        && (scoreLead(l, role).score ?? 0) > median) out.push({ lead: l, w: -0.3 });
    }
  }
  return out;
}

// Builds the model: a weight per word, only for words seen in at least 3 examples.
export function learn(leads, role, now = Date.now(), clients = []) {
  const ex = examples(leads, role, now, clients);
  const pos = ex.filter(e => e.w > 0), neg = ex.filter(e => e.w < 0);
  const P = pos.reduce((s, e) => s + e.w, 0), N = neg.reduce((s, e) => s - e.w, 0);
  const counts = new Map();
  for (const { lead, w } of ex) {
    for (const f of features(lead)) {
      const c = counts.get(f) || { p: 0, n: 0, seen: 0 };
      if (w > 0) c.p += w; else c.n -= w;
      c.seen++;
      counts.set(f, c);
    }
  }
  const weights = {};
  // too little to go on: stay out of the way
  // passed-over people alone are too weak a signal: wait for 2 real "no"s (exclusions or ignored invites)
  const hardNo = neg.filter(e => e.w <= -0.5).length;
  if (pos.length >= 5 && hardNo >= 2) {
    for (const [f, c] of counts) {
      if (c.seen < 3) continue;
      const lo = Math.log((c.p + 0.5) / (P + 1)) - Math.log((c.n + 0.5) / (N + 1));
      if (Math.abs(lo) >= 0.4) weights[f] = Math.max(-2, Math.min(2, lo));
    }
  }
  // shown to Kai: what the spec does not already say (the title words are scored anyway)
  const known = new Set(String(`${role?.title || ''} ${(role?.skills || []).join(' ')}`).toLowerCase().split(/\s+/));
  const top = (sign) => Object.entries(weights).filter(([f, w]) => sign * w > 0 && !f.startsWith('degree:') && !f.split(' ').every(x => known.has(x)))
    .sort((a, b) => sign * (b[1] - a[1])).slice(0, 4).map(([f]) => f);
  return {
    weights,
    known: [...known],
    active: Object.keys(weights).length > 0,
    picks: ex.filter(e => e.w === 1 || e.w === -1).length,
    hardNo,
    accepted: ex.filter(e => e.w === 2).length,
    replied: ex.filter(e => e.w === 3).length,
    favours: top(1),
    marksDown: top(-1),
  };
}

// Points to add or take away for one person: at most 15 either way, with the words behind it.
export function adjust(lead, model) {
  if (!model?.active) return { points: 0, reasons: [] };
  const hits = features(lead).filter(f => model.weights[f] !== undefined).map(f => [f, model.weights[f]]);
  if (!hits.length) return { points: 0, reasons: [] };
  const total = hits.reduce((s, [, w]) => s + w, 0);
  const points = Math.round(Math.max(-15, Math.min(15, total * 5)));
  if (!points) return { points: 0, reasons: [] };
  const known = new Set(model.known || []);
  const plain = f => f.startsWith('degree:') || f.split(' ').every(x => known.has(x));
  const sorted = hits.sort((a, b) => (plain(a[0]) - plain(b[0])) || Math.sign(points) * (b[1] - a[1]));
  const best = sorted[0][0].replace(/^degree:(.*)$/, '$1 degree');
  return { points, reasons: [points > 0 ? `you pick: ${best}` : `you pass on: ${best}`] };
}

// Connection note stats per note: sent, accepted, rate.
export function noteStats(notes, store, campaign) {
  const stats = notes.map(() => ({ sent: 0, accepted: 0 }));
  for (const a of store.data.actions) {
    // matched on the wording, so an edited or reordered note starts its own trial
    const i = a.type === 'connects' && a.campaign === campaign && typeof a.noteTemplate === 'string' ? notes.indexOf(a.noteTemplate) : -1;
    if (i < 0) continue;
    stats[i].sent++;
    const l = store.get(a.url) || Object.values(store.data.leads).find(x => x.recruiterUrl === a.url);
    if (l && (l.acceptedAt || ['accepted', 'messaged', 'replied', 'done'].includes(l.status))) stats[i].accepted++;
  }
  return stats.map(s => ({ ...s, rate: s.sent ? s.accepted / s.sent : null }));
}

// Which note to send: every note gets 15 sends first; after that the best one goes 4 times in 5.
export function chooseNote(notes, stats, rng = Math.random) {
  if (!notes.length) return -1;
  if (notes.length === 1) return 0;
  const fresh = stats.map((s, i) => [s.sent, i]).filter(([n]) => n < 15).sort((a, b) => a[0] - b[0]);
  if (fresh.length) return fresh[0][1];
  const best = stats.map((s, i) => [s.rate ?? 0, i]).sort((a, b) => b[0] - a[0])[0][1];
  if (rng() < 0.8) return best;
  const others = notes.map((_, i) => i).filter(i => i !== best);
  return others[Math.floor(rng() * others.length)];
}

// The list as Kai sees it: the spec match plus what has been learned for this role.
export function rankLearned(leads, role, model) {
  return leads.map(l => {
    let rank = scoreLead(l, role);
    if (model?.active && rank.score != null) {
      const a = adjust(l, model);
      if (a.points) rank = { ...rank, score: Math.max(0, Math.min(100, rank.score + a.points)), reasons: [...rank.reasons, ...a.reasons], learned: a.points };
    }
    return { ...l, ...cleanLead(l), rank };
  });
}
