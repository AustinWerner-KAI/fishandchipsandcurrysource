// Role facts are extracted from the saved brief, never inferred from a search domain.
export const LEGACY_INMAIL = "Hi {firstName},\n\nI'm running a search for a {role} with a growing digital asset business in {location}. {workType}.\n\nYour background looks close to what they're after, which is why I'm reaching out directly rather than posting it.\n\nWould you be open to hearing a bit more? A yes or no is fine either way.\n\nKai";
export const LEGACY_FIRST_MESSAGE = "Hi {firstName},\n\nHope you're well. I'm running a search for a {role} with a growing digital asset business in {location}. {workType}.\n\nYour background looks close to what they're after, so you were one of the first people I thought of.\n\nOpen to hearing a bit more? A yes or no is fine either way.\n\nKai";
export const ROLE_MESSAGE = "Hi {firstName},\n\n{rolePitch}\n\nWould you be open to hearing more? Happy to share the brief.\n\nKai";

const HEADINGS = /^(?:about (?:the role|the company|us|.+)|key responsibilities|responsibilities|requirements|qualifications|bonus skills|logistics|benefits(?:\/other)?|interview process|what you(?:'|’)ll do|the role)[: ]*$/i;
const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
const sentences = text => clean(text).split(/(?<=[.!?])\s+(?=[A-Z])/);

export function summaryFromSpec(spec) {
  const lines = String(spec || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^-- \d+ of \d+ --$/.test(s));
  const section = pattern => {
    const start = lines.findIndex(s => pattern.test(s));
    if (start < 0) return '';
    let end = start + 1;
    while (end < lines.length && !HEADINGS.test(lines[end])) end++;
    return clean(lines.slice(start + 1, end).join(' '));
  };
  const company = section(/^about (?!the role$)(?:the company|us|.+)[: ]*$/i);
  const responsibilities = section(/^(?:key responsibilities|responsibilities|what you(?:'|’)ll do)[: ]*$/i);
  const aboutRole = section(/^(?:about the role|the role)[: ]*$/i);
  const parts = [sentences(company)[0], ...sentences(responsibilities || aboutRole).slice(0, 2)].filter(Boolean);
  // Do not truncate a fact halfway through a sentence. Unstructured briefs need manual review.
  return anonymousSummary(parts.filter(s => s.length <= 1000).join(' ').trim(), { specText: spec });
}

export function rolePitch(role = {}) {
  const summary = anonymousSummary(typeof role.outreachSummary === 'string' ? role.outreachSummary.trim() : summaryFromSpec(role.specText), role);
  const location = role.workType === 'remote' && role.candidateLocations?.length ? role.candidateLocations.join(' / ') : role.location;
  const workType = { onsite: 'On site', hybrid: 'Hybrid', remote: 'Remote' }[role.workType];
  return [role.title ? `I'm recruiting for a ${role.title} role.` : "I'm recruiting for a new role.", summary,
    [location ? `Location: ${location}` : '', workType].filter(Boolean).join(' · ')].filter(Boolean).join('\n\n');
}

// Upgrade only the exact old shipped templates. Recruiter-authored copy is preserved.
export function upgradeOutreach(raw) {
  return { ...raw,
    ...(raw.inmail?.body === LEGACY_INMAIL ? { inmail: { ...raw.inmail, body: ROLE_MESSAGE } } : {}),
    ...(raw.firstDegree?.message === LEGACY_FIRST_MESSAGE ? { firstDegree: { ...raw.firstDegree, message: ROLE_MESSAGE } } : {}),
  };
}

// Hiring-company identity is private. Keep aliases separate from candidate employers.
export function hiringCompanyNames(role = {}) {
  const names = [role.company, role.client?.name, ...(role.client?.otherNames || []), ...(role.confidentialCompanyNames || [])];
  const spec = String(role.specText || '');
  for (const match of spec.matchAll(/^(?:Company|Employer|Client)\s*:\s*(.+)$/gmi)) names.push(match[1].trim());
  for (const match of spec.matchAll(/^About\s+(.+)$/gmi)) {
    const name = match[1].trim().replace(/:$/, '');
    if (!/^(?:the role|the company|us|you|the team|this role|the position)$/i.test(name)) names.push(name);
  }
  const companySection = spec.match(/(?:^|\n)About (?!the role)(?:the company|us)[: ]*\n([\s\S]*?)(?=\n(?:About|Key Responsibilities|Responsibilities|Requirements)|$)/i)?.[1];
  const namedSubject = companySection?.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim().match(/^(.{2,80}?)\s+(?:is|are)\s/i)?.[1];
  if (namedSubject && !/^(?:we|our client|the company|our company)$/i.test(namedSubject)) names.push(namedSubject);
  const expanded = names.filter(n => typeof n === 'string' && n.trim().length > 1).map(n => n.trim());
  for (const name of [...expanded]) {
    const short = name.replace(/\s+(?:group|inc\.?|ltd\.?|limited|llc|corporation|corp\.?)$/i, '').trim();
    if (short.length > 1 && short !== name) expanded.push(short);
  }
  return [...new Set(expanded)].sort((a,b) => b.length-a.length);
}
function namePattern(name) {
  return new RegExp('(?<![\\p{L}\\p{N}])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\p{L}\\p{N}])', 'giu');
}
export function containsHiringCompany(text, role) {
  return hiringCompanyNames(role).some(name => namePattern(name).test(String(text || '')));
}
export function anonymousSummary(text, role = {}) {
  let result = String(text || '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  for (const name of hiringCompanyNames(role)) result = result.replace(namePattern(name), 'the company');
  return result.replace(/^the company/i, 'The company');
}
