// {firstName} {name} {company} {headline} in templates. Unknown tags render empty.
// Squeezes double spaces and orphaned punctuation left by an empty tag.
export function render(template, lead = {}) {
  if (!template) return '';
  const vars = {
    firstName: lead.firstName || '',
    name: lead.name || '',
    company: lead.company || '',
    headline: lead.headline || '',
  };
  let out = template.replace(/\{(\w+)\}|\[(\w+)\]/g, (m, a, b) => {
    const key = (a || b);
    const norm = key.toLowerCase() === 'name' ? 'firstName' : key;
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
