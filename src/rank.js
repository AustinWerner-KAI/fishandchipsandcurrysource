// Scores a person against the role, 0 to 100, from what the search result shows: name line,
// headline, location. Simple and explainable: every point comes with a reason Kai can read.
import { splitTitle } from './role.js';

const DEGREE = /\s*[•·]\s*(1st|2nd|3rd\+?)\s*$/i;

// Search results come back as "Edward Lee • 3rd+" and sometimes a headline of just "• 3rd+".
export function cleanLead(lead) {
  let name = String(lead.name || '').trim();
  let degree = lead.degree || '';
  const m = name.match(DEGREE);
  if (m) { degree = degree || m[1]; name = name.replace(DEGREE, '').trim(); }
  let headline = String(lead.headline || '').trim();
  const hm = headline.match(/^[•·]\s*(1st|2nd|3rd\+?)$/i);
  if (hm) { degree = degree || hm[1]; headline = ''; }
  return { name, degree, headline };
}

const words = s => String(s || '').toLowerCase().replace(/"/g, '');
const has = (text, phrase) => new RegExp(`(^|[^a-z0-9])${phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(text);

const SENIOR = /\b(senior|sr\.?|lead|principal|staff|head|director|avp|vp|manager|architect)\b/i;
const JUNIOR = /\b(junior|jr\.?|intern|internship|graduate|student|trainee|apprentice|entry[- ]level|aspiring)\b/i;
const RECRUITER = /\b(recruit\w*|talent acquisition|headhunt\w*|sourcer|staffing)\b/i;

export function scoreLead(lead, role) {
  const { headline, degree } = cleanLead(lead);
  const text = words(headline);
  const reasons = [];
  let score = 0;
  if (!role) return { score: null, reasons: [] };
  if (!text) return { score: 15, reasons: ['no headline shown, open the profile'], degree };

  if (RECRUITER.test(text)) return { score: 0, reasons: ['recruiter'], degree };

  // title: 40 when it is their main title (first part of the headline), 25 when it is further down a list
  const split = splitTitle(role.title || '');
  const core = split.core || role.title || '';
  const titles = [...(role.titles || []), role.title, core].map(words).filter(Boolean);
  const main = text.split(/\s*(?:\||\/\/|•|·|,\s*(?=[a-z]+\s+at\b)|\bat\b|@)\s*/)[0] || text;
  if (titles.some(t => has(main, t))) { score += 40; reasons.push('title match'); }
  else if (titles.some(t => has(text, t))) { score += 25; reasons.push('title listed, not main'); }
  else {
    const coreWords = words(core).split(' ').filter(w => w.length > 2);
    const hit = coreWords.filter(w => has(text, w)).length;
    if (hit && hit === coreWords.length) { score += 25; reasons.push('title words'); }
    else if (hit) { score += 10; reasons.push('part of the title'); }
  }

  // must-haves from the role ("Cloud"): 20
  const must = (role.skills || []).map(words).filter(Boolean);
  if (must.length) {
    const got = must.filter(m => has(text, m));
    score += Math.round(20 * got.length / must.length);
    if (got.length) reasons.push(got.join(', '));
    else reasons.push(`no ${must.join(', ')}`);
  } else score += 10;

  // seniority: 15
  if (JUNIOR.test(text)) { score -= 20; reasons.push('junior'); }
  else if (SENIOR.test(text)) { score += 15; reasons.push('senior'); }
  else if (!split.seniority) score += 8;

  // industry: 15
  const industry = (role.domain || []).map(words).filter(Boolean);
  const ind = industry.find(d => has(text, d));
  if (ind) { score += 15; reasons.push(ind); }

  // skills the spec mentions: up to 5
  const titleWords = new Set(words(role.title).split(' '));
  const extra = (role.suggestedSkills || []).map(words).filter(s => s && !must.includes(s) && !titleWords.has(s) && has(text, s));
  if (extra.length) { score += Math.min(5, extra.length * 2); reasons.push(extra.slice(0, 2).join(', ')); }

  // reachable: 2nd degree accepts more often
  if (/^2nd$/i.test(degree)) { score += 5; reasons.push('2nd'); }

  return { score: Math.max(0, Math.min(100, score)), reasons, degree };
}

export function rankLeads(leads, role) {
  return leads.map(l => ({ ...l, ...cleanLead(l), rank: scoreLead(l, role) }));
}
