// One shape for everything that comes back from a public source, whichever site it came from.
// A "find" is one person as one site saw them. Several finds become one person in merge.js.

export function find(source, fields = {}) {
  return {
    source,                                   // which site
    handle: fields.handle || '',              // their name on that site
    name: fields.name || '',                  // their real name, when the site gives one
    url: fields.url || '',                    // their page on that site
    github: fields.github || '',              // the join key that matters most
    twitter: fields.twitter || '',
    email: fields.email || '',
    location: fields.location || '',
    company: fields.company || '',
    evidence: fields.evidence || [],          // [{ label, value }] — what this site proves about them
    lastActiveAt: fields.lastActiveAt || null,// the timing signal, ISO date, null when unknown
    weight: fields.weight ?? 0,               // how strong this find is, 0-100, for ordering
    // Handles this person is known by on OTHER sites. A lookup that resolves a pseudonym records
    // the handle it started from here, or the answer could never be joined back to the question.
    aliases: fields.aliases || [],            // [{ source, handle }]
  };
}

// Handles and names arrive in every casing and with @ signs on them.
export const cleanHandle = h => String(h || '').trim().replace(/^@+/, '').toLowerCase();

export function cleanName(n) {
  // The handle and the email are pulled out separately, and either can come last.
  return String(n || '').replace(/\s+/g, ' ')
    .replace(/\s*<[^>]*>/g, ' ')
    .replace(/\s*\(@[^)]*\)/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// "Vitalik Buterin (@vbuterin)" -> { name, github }
export function splitAuthored(text) {
  const s = String(text || '').trim();
  const gh = s.match(/\(@([A-Za-z0-9-]+)\)/);
  const mail = s.match(/<([^>]+@[^>]+)>/);
  return { name: cleanName(s), github: gh ? cleanHandle(gh[1]) : '', email: mail ? mail[1].trim() : '' };
}

// Package registries and repositories are full of release robots. None of them are people.
const BOT_NAMES = /^(github[- ]?actions?|npm|semantic-release|renovate|dependabot|greenkeeper|bot|ci|release[- ]?bot|automation|travis|circleci|snyk[- ]?bot|no[- ]?reply)$/i;
const BOT_MARKS = /(\[bot\]|-bot$|^bot-|\bactions?-user\b|no-?reply@|noreply@|@users\.noreply\.|oidc)/i;

export function isBot(who) {
  const { handle = '', name = '', email = '' } = who || {};
  const fields = [handle, name, email].map(v => String(v || '').trim()).filter(Boolean);
  if (!fields.length) return false;
  return fields.some(v => BOT_NAMES.test(v) || BOT_MARKS.test(v));
}

// ---- email hygiene ----
//
// An address is only useful if it is that person's. A shared inbox is worse than nothing: it is
// wrong to write to, and it merges two strangers into one record if it is used as a join key.
const ROLE_ADDRESS = /^(info|hello|hi|contact|admin|support|security|sales|team|dev|devs|oss|opensource|help|press|careers|jobs|hr|legal|abuse|postmaster|webmaster|noc|enquiries|office|mail|general|marketing)@/i;

// GitHub issues these. Collecting one is collecting a GitHub email address.
const GITHUB_ISSUED = /@users\.noreply\.github\.com$/i;

export function personalEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) return '';
  if (ROLE_ADDRESS.test(e) || GITHUB_ISSUED.test(e) || /no-?reply@/i.test(e)) return '';
  if (isBot({ email: e })) return '';
  return e;
}

// Anything that came off a page as free text can hold an address. Nothing with an email in it is
// ever shown next to a candidate, because an address we display is an address someone will use.
export function scrubEmails(text) {
  return String(text || '').replace(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g, '[email removed]');
}

// Two names are the same name. Handles accents and non-Latin scripts, which a-z alone does not.
export function nameKey(n) {
  const s = cleanName(n).normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  return s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

// A name with at least two parts is worth comparing. One word is a handle, not a name.
export const isFullName = n => nameKey(n).split(' ').filter(Boolean).length >= 2;
