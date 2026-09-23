// Company facts and tenure, kept as plain text-in, data-out helpers so they can be tested
// without a browser. Nothing here touches LinkedIn; the pass in actions/company.js does that.

export const MIN_TENURE_MONTHS = 12;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "2 yrs 3 mos", "11 months", "1 yr", "Jan 2023 - Present", "Mar 2019 – Aug 2021 · 2 yrs 6 mos".
// Returns whole months, or null when the text says nothing we can trust.
export function tenureMonths(text, now = new Date()) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // A spelled-out duration is the most reliable thing on the card.
  const yr = s.match(/(\d+)\s*(?:yrs?|years?)\b/i);
  const mo = s.match(/(\d+)\s*(?:mos?|months?)\b/i);
  if (yr || mo) return (+(yr?.[1] || 0)) * 12 + (+(mo?.[1] || 0));
  // Otherwise work it out from the dates: "Jan 2023 - Present", "2019 - 2021".
  const range = s.match(/([A-Za-z]{3,9})?\s*(\d{4})\s*[-–—]\s*(present|current|[A-Za-z]{3,9}?\s*\d{4})/i);
  if (!range) return null;
  const start = monthIndex(range[1]), startYear = +range[2];
  const end = /present|current/i.test(range[3])
    ? { y: now.getUTCFullYear(), m: now.getUTCMonth() }
    : { y: +(range[3].match(/\d{4}/)?.[0] || 0), m: monthIndex(range[3].match(/[A-Za-z]{3,9}/)?.[0]) };
  if (!startYear || !end.y) return null;
  const months = (end.y - startYear) * 12 + (end.m - start);
  return months >= 0 ? months : null;
}

function monthIndex(word) {
  const i = MONTHS.indexOf(String(word || '').slice(0, 3).toLowerCase());
  return i < 0 ? 0 : i;
}

// "2 yrs 4 mos" for the list. Empty string when we do not know.
export function tenureLabel(months) {
  if (months == null) return '';
  if (months < 12) return `${months} mo${months === 1 ? '' : 's'}`;
  const y = Math.floor(months / 12), m = months % 12;
  return m ? `${y} yr${y === 1 ? '' : 's'} ${m} mo${m === 1 ? '' : 's'}` : `${y} yr${y === 1 ? '' : 's'}`;
}

// Long enough in their current or last company to be worth approaching.
// Unknown is not the same as short: it stays visible and is marked as unknown.
export function tenureOk(months, min = MIN_TENURE_MONTHS) {
  return months == null ? null : months >= min;
}

// One key per company, so "Help AG", "help ag" and the /company/help-ag/ page are the same row.
export function companyKey(nameOrUrl) {
  const s = String(nameOrUrl || '').trim();
  if (!s) return null;
  const slug = s.match(/linkedin\.com\/company\/([^/?#]+)/i);
  if (slug) return decodeURIComponent(slug[1]).toLowerCase();
  // Only a trailing legal suffix is dropped, and only an unambiguous one:
  // "Help AG" and "Kraken Inc." must not both collapse to the same key.
  const name = s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\s,]+(inc|llc|ltd|limited|gmbh|plc|corp|corporation|pty|pte)\.?$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return name ? `name:${name}` : null;
}

// "201-500 employees", "10,001+ employees", "2-10 employees"
export function sizeBand(text) {
  const s = String(text || '').replace(/,/g, '');
  const range = s.match(/(\d+)\s*[-–—]\s*(\d+)\s*employees/i);
  if (range) return { min: +range[1], max: +range[2], label: `${range[1]}-${range[2]}` };
  const plus = s.match(/(\d+)\s*\+\s*employees/i);
  if (plus) return { min: +plus[1], max: null, label: `${plus[1]}+` };
  const one = s.match(/(\d+)\s*employees/i);
  if (one) return { min: +one[1], max: +one[1], label: String(one[1]) };
  return null;
}

// Startup, scale-up or enterprise, from the headcount band. Plain words for the list.
export function sizeWord(band) {
  if (!band) return '';
  const n = band.min ?? 0;
  if (n < 11) return 'tiny';
  if (n < 51) return 'startup';
  if (n < 201) return 'scale-up';
  if (n < 1001) return 'mid-size';
  if (n < 10001) return 'large';
  return 'enterprise';
}

// The About page reads as labelled lines: "Industry\nComputer and Network Security\nCompany size\n201-500 employees".
export function parseCompanyAbout(text) {
  const s = String(text || '').replace(/\r/g, '');
  const after = label => {
    const m = s.match(new RegExp(`${label}\\s*\\n+\\s*([^\\n]+)`, 'i'));
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  };
  const sector = after('Industry');
  const sizeLine = after('Company size') || (s.match(/([\d,]+(?:\s*[-–—]\s*[\d,]+|\+)?\s*employees)/i)?.[1] || '');
  const band = sizeBand(sizeLine);
  return { sector, size: band, sizeText: band ? `${band.label} employees` : '' };
}

// True only when we know they have been there less than `min` months.
// Unknown tenure is never treated as short: a parser that misses must not hide the whole list.
export function tooNewInRole(lead, min = MIN_TENURE_MONTHS) {
  return tenureOk(lead?.tenureMonths, min) === false;
}
