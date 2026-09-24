// Every public source worth knowing about, and what we are allowed to do with it.
//
// `use` is the only field that decides behaviour:
//   'auto'   Sourcer may fetch it. Licence permits it, or the site imposes no restriction.
//   'manual' Sourcer opens the page for Kai to read. Their terms forbid automated collection,
//            so nothing here is ever fetched, parsed or stored by the app.
//   'avoid'  Not worth the effort, or the terms rule it out entirely. Listed so nobody
//            re-researches it in six months.
//
// Researched 24 Sep 2026. `licence` records what the site itself says, and "silent" means the
// terms do not address automated use at all — which is unresolved risk, never permission.

export const SOURCES = [
  // ---- discovery: find people we did not know about ----
  {
    id: 'eips', title: 'Ethereum EIP and ERC authors', use: 'auto', role: 'discovery',
    licence: 'CC0 public domain', proves: 'Wrote a change to Ethereum itself and got it through peer review',
    gives: ['name', 'github'], timing: 'EIP status and the date it was created',
    note: 'The cleanest source there is: real name and GitHub handle in one structured field, no key, no rate limit.',
  },
  {
    id: 'stackexchange', title: 'Stack Exchange top answerers', use: 'auto', role: 'discovery',
    licence: 'CC BY-SA 4.0, commercial use permitted with attribution',
    proves: 'Ranked by peers for answering hard questions in one subject',
    gives: ['name', 'location', 'website'], timing: 'Last time they loaded the site, and their reputation trend',
    note: 'Security, Ethereum, Bitcoin and Quant all have their own sites.',
  },
  {
    id: 'sherlock', title: 'Sherlock audit leaderboard', use: 'auto', role: 'discovery',
    licence: 'silent — no terms page published, no robots restriction',
    proves: 'Paid for finding real bugs in live protocols, and Sherlock grade them senior themselves',
    gives: ['handle'], timing: 'Days active on the platform',
    note: 'Thirty-five individuals carry Sherlock\\u2019s own senior grade. They are pseudonymous, and the board will not tell you who they are, so this says who is worth chasing rather than who to contact.',
  },
  {
    id: 'npm', title: 'npm package maintainers', use: 'auto', role: 'discovery',
    licence: 'Registry reads permitted; npm terms forbid passing npm data to others',
    proves: 'Maintains a package other people depend on',
    gives: ['name', 'email'], timing: 'When they last published',
    note: 'Returns working email addresses with no key at all. Never pass this data on to anyone else.',
  },
  {
    id: 'github', title: 'GitHub user search', use: 'auto', role: 'discovery',
    licence: 'Acceptable Use Policy names recruiters — see the warning below',
    proves: 'What they actually build, in public, with dates',
    gives: ['name', 'location', 'company', 'email', 'website'], timing: 'Last push, and their profile employer changing',
    warning: 'GitHub’s Acceptable Use Policy forbids using information from GitHub for "sending unsolicited emails to users or selling personal information, such as to recruiters, headhunters, and job boards". Sourcer uses GitHub to find and check people, and never to send them anything or to pass their details on. Keep it that way.',
  },

  // ---- enrichment: turn a handle into a person ----
  {
    id: 'hackerone', title: 'HackerOne researcher profiles', use: 'auto', role: 'enrichment',
    licence: 'silent — no scraping clause found in their terms, no robots restriction',
    proves: 'Found real bugs against hostile triage; signal and impact scores are quality weighted',
    gives: ['name', 'github', 'twitter'], timing: 'Account age',
    note: 'The one source that hands over a real name and a GitHub handle together, so it joins everything else up.',
  },
  {
    id: 'crates', title: 'crates.io Rust authors', use: 'auto', role: 'enrichment',
    licence: 'Open API, descriptive user agent required',
    proves: 'Writes production Rust, which is the language of both infrastructure security and several chains',
    gives: ['name', 'github'], timing: 'When they last published',
    note: 'Confirms whether a crates handle really is that GitHub account.',
  },
  {
    id: 'trailofbits', title: 'Trail of Bits audit reports', use: 'auto', role: 'enrichment',
    licence: 'Public repository the firm publishes deliberately',
    proves: 'Audited real protocols for one of the best known security firms',
    gives: ['name'], timing: 'Every report is dated, so someone who stops appearing has left',
    note: 'About a hundred named auditors. The dates are the point: they show departures.',
  },

  // ---- read by hand: their terms forbid us fetching it ----
  {
    id: 'code4rena', title: 'Code4rena leaderboard', use: 'manual', role: 'discovery',
    url: 'https://code4rena.com/leaderboard',
    licence: 'Terms of Service section 8(g) forbids automated access, scraping and bulk download',
    proves: 'Ranked against hundreds of auditors on the same code. A solo high severity finding is one nobody else caught',
    note: 'Around 235 auditors have ticked "available for hire" in public. That is the highest yield list in this whole set, and we are not allowed to fetch it. Open it and read it. Their terms mention a separate written agreement, so it is worth asking them for one.',
  },
  {
    id: 'immunefi', title: 'Immunefi bug bounty leaderboard', use: 'manual', role: 'discovery',
    url: 'https://immunefi.com/leaderboard/',
    licence: 'Terms of Use forbid any robot or automated means, and even manual copying',
    proves: 'Paid millions for bugs that would have drained live protocols',
    note: 'Best evidence anywhere, worst terms anywhere. Read it, do not store it.',
  },
  {
    id: 'defcon', title: 'DEF CON speakers', use: 'manual', role: 'discovery',
    url: 'https://defcon.org/',
    licence: 'robots.txt blocks automated agents by name',
    proves: 'A talk accepted by a hostile review committee, with their employer in the bio',
    note: 'Comparing one year’s bio against the next tells you who changed jobs. Worth half an hour, by hand.',
  },
  {
    id: 'cisa-ics', title: 'CISA industrial advisories', use: 'manual', role: 'discovery',
    url: 'https://www.cisa.gov/news-events/cybersecurity-advisories',
    licence: 'US government work, but the site refuses anything that is not a browser',
    proves: 'Named in an advisory alongside their employer',
  },

  // ---- researched and rejected ----
  { id: 'etherscan', use: 'avoid', title: 'Etherscan', why: 'Deployers are wallet addresses, never people, and the terms forbid dataset creation for good.' },
  { id: 'snapshot', use: 'avoid', title: 'Snapshot DAO votes', why: 'Voters are wallet addresses. Voting proves you hold a token, not that you can build.' },
  { id: 'hibp', use: 'avoid', title: 'Have I Been Pwned', why: 'Holds breaches, not people. Using it on a candidate would be indefensible.' },
  { id: 'nvd', use: 'avoid', title: 'NVD', why: 'Its records have no credits field. MITRE names finders, but only about one in ten is a person.' },
  { id: 'bugcrowd', use: 'avoid', title: 'Bugcrowd', why: 'Same people as HackerOne, nothing in the page, no way to join an identity.' },
  { id: 'certs', use: 'avoid', title: 'CISSP and OSCP registries', why: 'You verify a certificate number you already have. There is no directory, and neither marks out a senior engineer.' },
  { id: 'devpost', use: 'avoid', title: 'Devpost and ETHGlobal', why: 'Bot blocked, and hackathon winners are juniors.' },
  { id: 'pypi', use: 'avoid', title: 'PyPI', why: 'No people endpoint, and author fields are now team inboxes.' },
  { id: 'huggingface', use: 'avoid', title: 'Hugging Face', why: 'Good API, machine learning people. Not our market.' },
  { id: 'wellfound', use: 'avoid', title: 'Wellfound and AngelList', why: 'The public API is a graveyard of 404s. Go to the company’s own job board instead.' },
  { id: 'linkedin-bulk', use: 'avoid', title: 'Bulk LinkedIn scraping', why: 'LinkedIn sues. Proxycurl was making millions and shut down in six months; hiQ paid $500,000 and was ordered to destroy everything it had built. Recruiter Lite under our own licence is fine. Collecting LinkedIn at scale for a product is not.' },
];

// Frozen on purpose. This list is the only thing standing between the tool and fetching a site
// whose terms forbid it, so nothing in this process can quietly flip a source to 'auto'.
Object.freeze(SOURCES);
for (const s of SOURCES) Object.freeze(s);

export const byId = id => SOURCES.find(s => s.id === id) || null;
export const automated = () => SOURCES.filter(s => s.use === 'auto');
export const manualOnly = () => SOURCES.filter(s => s.use === 'manual');
export const rejected = () => SOURCES.filter(s => s.use === 'avoid');

// Nothing outside the automated list is ever fetched. Adapters call this before they run.
export function mayFetch(id) {
  const s = byId(id);
  if (!s) throw new Error(`Unknown source: ${id}`);
  if (s.use !== 'auto') throw new Error(`${s.title} must not be fetched automatically: ${s.licence || s.why}`);
  return true;
}

// Where each automated source is allowed to lead. A redirect to anywhere else is refused.
export const HOSTS = Object.freeze({
  stackexchange: ['api.stackexchange.com'],
  sherlock: ['sherlock.xyz'],
  npm: ['registry.npmjs.org', 'npmjs.org'],
  crates: ['crates.io'],
  github: ['api.github.com', 'github.com'],
  hackerone: ['hackerone.com'],
});
