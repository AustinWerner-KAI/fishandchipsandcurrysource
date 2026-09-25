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
  return parts.filter(s => s.length <= 1000).join(' ').trim();
}

export function rolePitch(role = {}) {
  const summary = typeof role.outreachSummary === 'string' ? role.outreachSummary.trim() : summaryFromSpec(role.specText);
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
