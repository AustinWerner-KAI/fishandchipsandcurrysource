// What Kai's corrections to a drafted role teach the role reader (24 Sep 2026).
// Each saved new role keeps the spec, what Sourcer guessed and what Kai saved. From that:
//   - a skill Kai adds is looked for in future specs; one he keeps removing is not offered again
//   - every kept spec is re-read by the current reader, so its score shows whether a change to the
//     reader made it better or worse on Kai's own roles
// Kept in ~/.sourcer/role-lessons.json, on this Mac only.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, ensureDirs } from './paths.js';

const file = () => path.join(HOME, 'role-lessons.json');
const MAX_LESSONS = 60;
const low = s => String(s || '').trim().toLowerCase();
const norm = t => low(t).replace(/\s+/g, ' ').replace(/^(senior|lead|principal|staff|junior)\s+/, '');

export function readLessons() {
  try { const j = JSON.parse(fs.readFileSync(file(), 'utf8')); return { lessons: j.lessons || [], vocab: { added: j.vocab?.added || {}, dropped: j.vocab?.dropped || {} } }; }
  catch { return { lessons: [], vocab: { added: {}, dropped: {} } }; }
}
function write(all) {
  ensureDirs();
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

// The words the reader should add to, or leave out of, its skill vocabulary. A word counts as
// dropped only when Kai removed it more often than he added it.
export function vocab() {
  const { vocab: v } = readLessons();
  const learned = Object.keys(v.added).filter(w => (v.added[w] || 0) > (v.dropped[w] || 0));
  const dropped = Object.keys(v.dropped).filter(w => (v.dropped[w] || 0) > (v.added[w] || 0));
  return { learned, dropped };
}

// guess: what the reader drafted; final: what Kai saved. Returns what changed.
export function recordLesson({ text = '', guess = {}, final = {} } = {}) {
  if (!String(text).trim() || !guess.title) return null;
  const all = readLessons();
  // what Kai did to the skill chips: the must-have words are the role's title words, not taught skills
  const g = new Set((guess.skills || []).map(low)), f = new Set((final.suggestedSkills || []).map(low));
  const added = [...f].filter(w => w && !g.has(w)), removed = [...g].filter(w => w && !f.has(w));
  for (const w of added) all.vocab.added[w] = (all.vocab.added[w] || 0) + 1;
  for (const w of removed) all.vocab.dropped[w] = (all.vocab.dropped[w] || 0) + 1;
  const lesson = {
    at: new Date().toISOString(),
    text: String(text).slice(0, 20000),
    guess: { title: guess.title || '', skills: guess.skills || [], boolean: guess.boolean || '', boolean2: guess.boolean2 || '' },
    final: { title: final.title || '', skills: final.skills || [], boolean: final.boolean || '', boolean2: final.boolean2 || '' },
    titleRight: norm(guess.title) === norm(final.title),
    added, removed,
  };
  all.lessons = [...all.lessons, lesson].slice(-MAX_LESSONS);
  write(all);
  return lesson;
}

// Re-reads every kept spec with today's reader: how often would the title now be right first time?
// `draft` is draftRole, passed in so this file does not import the reader (the reader imports this).
export function score(draft) {
  const { lessons } = readLessons();
  let right = 0;
  for (const l of lessons) { try { if (norm(draft(l.text).title) === norm(l.final.title)) right++; } catch { /* a spec that no longer parses counts as wrong */ } }
  return { right, of: lessons.length };
}

// For the New role screen: the score and the latest things learned, in plain words.
export function summary(draft) {
  const all = readLessons();
  const v = vocab();
  const recent = all.lessons.slice(-5).reverse();
  return {
    score: score(draft),
    learned: [...new Set(recent.flatMap(l => l.added))].filter(w => v.learned.includes(w)).slice(0, 4),
    dropped: [...new Set(recent.flatMap(l => l.removed))].filter(w => v.dropped.includes(w)).slice(0, 4),
    titleFixes: recent.filter(l => !l.titleRight).slice(0, 3).map(l => ({ was: l.guess.title, now: l.final.title })),
  };
}
