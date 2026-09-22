// {firstName} {name} {company} {headline} plus, from the campaign's role, {role} {location} {workType}.
// Unknown tags render empty. Squeezes double spaces and orphaned punctuation left by an empty tag.
const WORK_TYPE_TEXT = { onsite: 'On site', hybrid: 'Hybrid, in the office part of the week', remote: 'Fully remote' };

export function roleVars(role) {
  if (!role) return { role: '', location: '', workType: '' };
  const where = role.workType === 'remote' && role.candidateLocations?.length ? role.candidateLocations.join(' / ') : (role.location || '');
  return { role: role.title || '', location: where, workType: WORK_TYPE_TEXT[role.workType] || '' };
}

export function render(template, lead = {}, role = null) {
  if (!template) return '';
  const vars = {
    firstName: lead.firstName || '',
    name: lead.name || '',
    company: lead.company || '',
    headline: lead.headline || '',
    ...roleVars(role),
  };
  let out = template.replace(/\{(\w+)\}|\[(\w+)\]/g, (m, a, b) => {
    const key = (a || b);
    const low = key.toLowerCase();
    const norm = low === 'name' ? 'firstName' : low === 'firstname' ? 'firstName' : low === 'worktype' ? 'workType' : low === 'rolename' || low === 'role' ? 'role' : key;
    return vars[norm] ?? vars[key] ?? '';
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
