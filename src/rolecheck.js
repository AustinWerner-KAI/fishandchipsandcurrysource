// The role check (24 Sep 2026): every drafted or edited role is checked before it is saved, and each
// finding is a plain sentence with, where there is one, a one-click fix. Built after the Palantir
// spec came out as a role titled "New York, NY" searching for `New AND ("York, NY" OR ...)`.
//   level: 'bad'  would search for the wrong people; saving asks first
//          'warn' worth a look
//          'ok'   checked and fine (shown so Kai can see what was checked)
import { JOB_WORD, familyOf, FAMILY_WORD, splitTeam, isPlace } from './role.js';

const STOP = new Set(['and', 'or', 'not', 'the', 'a', 'an', 'of', 'in', 'at', 'for', 'to', 'new', 'with', 'on']);
const low = s => String(s || '').trim().toLowerCase();

// The terms a boolean is built from, without the NOT part: groups are split into their words.
function andTerms(boolean) {
  const b = String(boolean || '').split(/\bNOT\b/)[0];
  const out = [];
  let depth = 0, cur = '';
  for (const ch of b) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    cur += ch;
    if (depth === 0 && /\s/.test(ch) && /\sAND\s$/.test(cur)) { out.push(cur.replace(/\sAND\s$/, '').trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}
const termsIn = g => g.replace(/^\(|\)$/g, '').split(/\s+OR\s+/).map(t => t.replace(/"/g, '').trim()).filter(Boolean);

// Words in a boolean that cannot be what Kai meant: punctuation, stop words, places, the company.
export function strayTerms(boolean, { company = '' } = {}) {
  const bad = [];
  for (const g of andTerms(boolean)) for (const t of termsIn(g)) {
    // R and C are languages; any other single character is a slip
    if (!/[a-z0-9]/i.test(t) || (t.length === 1 && !/^[RC]$/.test(t))) bad.push({ term: t, why: 'a stray character' });
    else if (STOP.has(low(t))) bad.push({ term: t, why: 'a stray word' });
    else if (isPlace(t) || /\b(york|francisco|angeles|dubai|london|singapore)\b/i.test(t) && !JOB_WORD.test(t)) bad.push({ term: t, why: 'a place (locations are set as a filter, not searched as words)' });
    else if (company && low(t) === low(company)) bad.push({ term: t, why: "the hiring company's own name" });
  }
  return bad;
}

// role: title, location, workType, titles, skills, recruiterSkills, domain, boolean, boolean2, company
// text: the spec, when there is one (an edit of a saved role has none)
export function checkRole(role = {}, { text = '' } = {}) {
  const out = [];
  const add = (id, level, title, detail = '', fix = null) => out.push({ id, level, title, detail, ...(fix ? { fix } : {}) });
  const title = String(role.title || '').trim();
  const titles = role.titles || [];
  const spec = String(text || '');

  // 1. the title is a job
  if (!title) add('title', 'bad', 'No job title', 'Sourcer could not find one in the spec. Pick one below or type it.', { kind: 'pickTitle' });
  else if (isPlace(title) || low(title) === low(role.location)) add('title', 'bad', 'The title looks like a place, not a job', `"${title}" is where the role is.`, { kind: 'pickTitle' });
  else if (/^https?:/i.test(title)) add('title', 'bad', 'The title is a link', 'Read the link as a job, or type the title.', { kind: 'pickTitle' });
  else if (!JOB_WORD.test(title)) add('title', 'bad', 'No job word in the title', `"${title}" has no word like engineer, manager, director or head.`, { kind: 'pickTitle' });
  else if (role.company && low(title) === low(role.company)) add('title', 'bad', "The title is the company's name", '', { kind: 'pickTitle' });
  else if (splitTeam(title).team) add('title', 'warn', 'The title still has a team in it', `"${splitTeam(title).title}" is the job; "${splitTeam(title).team}" is the team.`, { kind: 'setTitle', value: splitTeam(title).title });
  else if (role.titleGuessed) add('title', 'warn', 'The spec does not name the job, so Sourcer guessed it', `"${title}" is a guess from what the spec is about. Check it, or pick another.`, { kind: 'pickTitle' });
  else add('title', 'ok', 'The title is a job', `"${title}" has a job word and is not the location${role.company ? ', the company' : ''} or a team.`);

  // 2. the title fits what the spec is about
  if (title && spec) {
    const fromTitle = familyOf(title), fromSpec = familyOf('', spec);
    const close = (a, b) => a === b || (['engineering', 'security'].includes(a) && ['engineering', 'security'].includes(b));
    if (fromSpec && fromTitle && !close(fromTitle, fromSpec)) add('fit', 'warn', 'The title and the spec disagree', `The title reads as ${FAMILY_WORD[fromTitle]}, the spec reads as ${FAMILY_WORD[fromSpec]}.`, { kind: 'pickTitle' });
    else if (fromSpec) add('fit', 'ok', 'The title matches the spec', `The spec reads as ${FAMILY_WORD[fromSpec]}.`);
  }

  // 3. nothing stray in either search
  const stray = [...strayTerms(role.boolean, role), ...strayTerms(role.boolean2, role)];
  if (stray.length) add('stray', 'bad', 'The search has words that should not be there', stray.slice(0, 4).map(s => `"${s.term}" is ${s.why}`).join('; ') + '.', { kind: 'rebuild' });
  else add('stray', 'ok', 'No stray words in either search', 'No single letters, dashes, places or the company\'s own name.');
  if (titles.some(t => isPlace(t) || /\bnew york\b|\bny\b/i.test(t))) add('titles', 'bad', 'A job title in the search is a place', titles.filter(t => isPlace(t)).join(', '), { kind: 'rebuild' });

  // 4. the key skill is used
  const key = (role.recruiterSkills || [])[0] || '';
  if (!key) add('key', 'warn', 'No key skill', "Recruiter's Skills filter will be empty, and Search 2 has less to go on.");
  else if (role.boolean2 && !low(role.boolean2).includes(low(key))) add('key', 'warn', `Search 2 does not include the key skill, ${key}`, '', { kind: 'rebuild2' });
  else add('key', 'ok', `The key skill is used: ${key}`, `Recruiter's Skills filter${role.boolean2 ? ' and Search 2' : ''}.`);

  // 5. location and work type
  if (role.workType !== 'remote' && !role.location) add('where', 'warn', 'No office location', 'The search would cover everywhere.');
  else add('where', 'ok', 'Location and work type found', [role.location, role.workType].filter(Boolean).join(' · '));

  // 6. the second search is a different search
  if (!role.boolean2) add('differ', 'warn', 'No second search', 'It needs a key skill and one more skill or must-have word.', { kind: 'rebuild2' });
  else if (titles.some(t => low(role.boolean2).includes(low(t)))) add('differ', 'warn', 'Search 2 repeats Search 1\'s titles', 'It should find the people the titles miss.', { kind: 'rebuild2' });
  else add('differ', 'ok', 'The two searches are different', 'Search 2 does not need any of Search 1\'s titles.');

  // 7. seniority against the years the spec asks for
  const years = [...spec.matchAll(/\b(\d{1,2})\s*\+?\s*(?:years|yrs)\b/gi)].map(m => +m[1]).filter(n => n > 0 && n < 30);
  if (years.length) {
    const most = Math.max(...years);
    const senior = titles.filter(t => /^(senior|lead|principal|staff)\b/i.test(t));
    if (most <= 4 && senior.length) add('seniority', 'warn', `Seniority: the spec asks for ${most}+ years`, `Search 1 includes ${senior.map(t => `"${t}"`).join(', ')}. Keep it, or drop it to reach mid-level people too.`, { kind: 'seniority' });
  }
  return out;
}

export const blocking = checks => checks.filter(c => c.level === 'bad');
