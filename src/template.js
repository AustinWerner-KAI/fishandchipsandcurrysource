// {firstName} {name} {company} {headline} plus, from the campaign's role, {role} {location} {workType}.
// Unknown tags render empty. Squeezes double spaces and orphaned punctuation left by an empty tag.
const WORK_TYPE_TEXT = { onsite: 'On site', hybrid: 'Hybrid, in the office part of the week', remote: 'Fully remote' };

export function roleVars(role) {
  if (!role) return { role: '', location: '', workType: '' };
  const where = role.workType === 'remote' && role.candidateLocations?.length ? role.candidateLocations.join(' / ') : (role.location || '');
  return { role: role.title || '', location: where, workType: WORK_TYPE_TEXT[role.workType] || '' };
}

export const TAGS = ['firstName', 'name', 'company', 'headline', 'role', 'location', 'workType'];
const TAG_RE = /\{(\w+)\}|\[(\w+)\]/g;
const normTag = key => {
  const low = key.toLowerCase();
  if (low === 'name' || low === 'firstname') return 'firstName';
  if (low === 'worktype') return 'workType';
  if (low === 'rolename' || low === 'role') return 'role';
  return TAGS.find(t => t.toLowerCase() === low) || null;
};

// Tags in a template that would come out empty because they are misspelt, e.g. {first name} or {fristName}.
export function unknownTags(template) {
  const out = [];
  for (const m of String(template || '').matchAll(/\{([^{}]*)\}/g)) if (!/^\w+$/.test(m[1]) || !normTag(m[1])) out.push(m[0]);
  return out;
}

// The first name as it should appear in a message: "JOHN" and "john" become "John", initials don't count.
export function nameFor(lead = {}) {
  let n = String(lead.firstName || '').trim();
  if (n.replace(/[^\p{L}]/gu, '').length < 2) return '';
  if (n === n.toUpperCase() || n === n.toLowerCase()) n = n.toLowerCase().replace(/(^|[-'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  return n;
}

const usesName = t => [...String(t || '').matchAll(TAG_RE)].some(m => normTag(m[1] || m[2]) === 'firstName');

// Renders and says why it must not be sent: no first name for a message that greets by name,
// or a tag left unfilled. Nothing goes out with a gap where the name should be.
export function renderChecked(template, lead = {}, role = null) {
  const text = render(template, lead, role);
  let problem = '';
  if (usesName(template) && !nameFor(lead)) problem = 'no first name found, press Set first name';
  else if (unknownTags(template).length) problem = `unknown tag ${unknownTags(template)[0]}`;
  else if (/\{\w*\}/.test(text)) problem = 'a tag was not filled';
  return { text, problem };
}

export function render(template, lead = {}, role = null) {
  if (!template) return '';
  const vars = {
    firstName: nameFor(lead),
    name: lead.name || '',
    company: lead.company || '',
    headline: lead.headline || '',
    ...roleVars(role),
  };
  let out = template.replace(TAG_RE, (m, a, b) => {
    const key = (a || b);
    const norm = normTag(key);
    if (!norm && b) return m;              // [text] that is not a tag stays as written
    return vars[norm] ?? '';
  });
  out = out.replace(/ ,/g, ',').replace(/  +/g, ' ').replace(/^\s*,\s*/, '').trim();
  return out;
}

export function checkNote(text, max = 300) {
  const problems = [];
  if (!text) problems.push('empty');
  if (text && text.length > max) problems.push(`too long (${text.length}/${max})`);
  if (/[—–]/.test(text || '')) problems.push('contains a dash');
  return problems;
}
