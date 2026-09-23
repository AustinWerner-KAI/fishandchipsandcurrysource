import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpHome } from './helpers.js';
const home = tmpHome();
const { Store } = await import('../src/store.js');
const {
  tenureMonths, tenureLabel, tenureOk, tooNewInRole,
  companyKey, sizeBand, sizeWord, parseCompanyAbout,
} = await import('../src/company.js');
const { runCompanyLookups } = await import('../src/actions/company.js');

test('tenure is read from however LinkedIn wrote it', () => {
  assert.equal(tenureMonths('2 yrs 3 mos'), 27);
  assert.equal(tenureMonths('1 yr'), 12);
  assert.equal(tenureMonths('11 months'), 11);
  assert.equal(tenureMonths('Help AG · 4 yrs 1 mo'), 49);
  assert.equal(tenureMonths('Jan 2023 - Present', new Date('2026-09-23T00:00:00Z')), 44);
  assert.equal(tenureMonths('Mar 2019 – Aug 2021'), 29);
  // a spelled-out duration beats the dates when both are there
  assert.equal(tenureMonths('Mar 2019 – Aug 2021 · 2 yrs 6 mos'), 30);
});

test('tenure we cannot read is unknown, never zero', () => {
  for (const bad of ['', null, undefined, 'Full-time', 'Dubai']) assert.equal(tenureMonths(bad), null);
  assert.equal(tenureOk(null), null);
  assert.equal(tooNewInRole({ tenureMonths: null }), false);    // unknown is never treated as short
  assert.equal(tooNewInRole({ tenureMonths: 11 }), true);
  assert.equal(tooNewInRole({ tenureMonths: 12 }), false);
  assert.equal(tooNewInRole({ tenureMonths: 11 }, 6), false);   // the bar is settable per role
});

test('tenure reads back in plain words', () => {
  assert.equal(tenureLabel(27), '2 yrs 3 mos');
  assert.equal(tenureLabel(12), '1 yr');
  assert.equal(tenureLabel(1), '1 mo');
  assert.equal(tenureLabel(8), '8 mos');
  assert.equal(tenureLabel(null), '');
});

test('one company key per employer, whatever it is called', () => {
  assert.equal(companyKey('Kraken'), companyKey('Kraken Inc.'));
  assert.equal(companyKey('https://www.linkedin.com/company/help-ag/about/'), 'help-ag');
  assert.equal(companyKey('Help & Co'), companyKey('help and co'));
  // a two letter name is not a legal suffix to be stripped
  assert.notEqual(companyKey('Help AG'), companyKey('Help'));
  assert.equal(companyKey(''), null);
});

test('headcount reads as a band and a plain word', () => {
  assert.deepEqual(sizeBand('201-500 employees'), { min: 201, max: 500, label: '201-500' });
  assert.deepEqual(sizeBand('10,001+ employees'), { min: 10001, max: null, label: '10001+' });
  assert.equal(sizeBand('no idea'), null);
  assert.equal(sizeWord(sizeBand('11-50 employees')), 'startup');
  assert.equal(sizeWord(sizeBand('10,001+ employees')), 'enterprise');
  assert.equal(sizeWord(null), '');
});

test('the About page gives sector and size', () => {
  const p = parseCompanyAbout('Overview\nIndustry\nComputer and Network Security\nCompany size\n201-500 employees\nHeadquarters\nDubai');
  assert.equal(p.sector, 'Computer and Network Security');
  assert.equal(p.sizeText, '201-500 employees');
  assert.equal(parseCompanyAbout('').sector, '');
});

const cfg = { name: 'c1' };

function seed(people) {
  fs.rmSync(path.join(home, 'db.json'), { force: true });   // each test starts from nothing
  const s = new Store();
  s.data = { meta: {}, leads: {}, companies: {}, actions: [] };
  people.forEach((p, i) => s.upsertLead({ url: `https://www.linkedin.com/in/p${i}`, campaign: 'c1', ...p }));
  s.save();
  return s;
}

test('the commonest employers are looked up first, and only once', async () => {
  const s = seed([
    { name: 'A', company: 'Help AG' }, { name: 'B', company: 'Help AG' }, { name: 'C', company: 'Rain' },
  ]);
  assert.deepEqual(s.companiesToLookUp({ campaign: 'c1' }).map(c => [c.name, c.people]), [['Help AG', 2], ['Rain', 1]]);

  const seen = [];
  const ops = {
    findCompanyPage: async (_p, name) => { seen.push(name); return `https://www.linkedin.com/company/${name.toLowerCase().replace(/ /g, '-')}/`; },
    readCompanyAbout: async () => ({ sector: 'Computer and Network Security', size: { min: 201, max: 500, label: '201-500' }, sizeText: '201-500 employees' }),
  };
  const r = await runCompanyLookups({}, s, cfg, { ops, pause: false });
  assert.equal(r.read, 2);
  assert.deepEqual(seen, ['Help AG', 'Rain']);

  s.load();
  const lead = s.get('https://www.linkedin.com/in/p0');
  assert.equal(s.companyFor(lead).sector, 'Computer and Network Security');
  assert.equal(s.companyFor(lead).sizeText, '201-500 employees');
  // nothing is looked up twice
  assert.deepEqual(s.companiesToLookUp({ campaign: 'c1' }), []);
  const again = await runCompanyLookups({}, s, cfg, { ops, pause: false });
  assert.equal(again.read, 0);
});

test('a company that cannot be found is dropped after three tries, not retried forever', async () => {
  const s = seed([{ name: 'A', company: 'Nowhere Ltd' }]);
  const ops = { findCompanyPage: async () => null, readCompanyAbout: async () => null };
  for (let i = 0; i < 3; i++) {
    assert.equal(s.companiesToLookUp({ campaign: 'c1' }).length, 1, `try ${i + 1} should still be offered`);
    await runCompanyLookups({}, s, cfg, { ops, pause: false });
    s.load();
  }
  assert.deepEqual(s.companiesToLookUp({ campaign: 'c1' }), []);
});

test('a security check during a lookup stops the run', async () => {
  const s = seed([{ name: 'A', company: 'Help AG' }]);
  const boom = Object.assign(new Error('checkpoint'), { name: 'CheckpointError' });
  const ops = { findCompanyPage: async () => { throw boom; }, readCompanyAbout: async () => null };
  await assert.rejects(() => runCompanyLookups({}, s, cfg, { ops, pause: false }), /checkpoint/);
});

test('company facts survive another process writing at the same time', async () => {
  const a = seed([{ name: 'A', company: 'Help AG' }]);
  a.setCompany('Help AG', { name: 'Help AG', sector: 'Security' });
  const b = new Store().load();
  b.upsertLead({ url: 'https://www.linkedin.com/in/other', campaign: 'c1', name: 'Z' });
  b.save();                       // the app writes while the runner is looking companies up
  a.save();
  const fresh = new Store().load();
  assert.equal(fresh.data.companies[companyKey('Help AG')].sector, 'Security');
  assert.ok(fresh.get('https://www.linkedin.com/in/other'));
});

test('someone under a year at their employer is not invited or InMailed', async () => {
  const { runConnect } = await import('../src/actions/connect.js');
  const { runInMails } = await import('../src/actions/inmail.js');
  const s = new Store(path.join(home, `db-tenure-${Math.random()}.json`));
  s.data.meta.ownName = 'Kai Crayford';
  s.data.meta.inmailApprovedAt = '2026-01-01T00:00:00.000Z';   // past the rehearsal
  s.data.meta.inmailBalance = 50;
  s.upsertLead({ url: 'linkedin.com/in/long', name: 'Long Stayer', campaign: 'c1', approved: true, degree: '2nd', tenureMonths: 30 });
  s.upsertLead({ url: 'linkedin.com/in/short', name: 'Short Stayer', campaign: 'c1', approved: true, degree: '2nd', tenureMonths: 5 });
  s.upsertLead({ url: 'linkedin.com/in/unknown', name: 'Unknown Stayer', campaign: 'c1', approved: true, degree: '2nd' });
  s.save();

  const connectCfg = {
    name: 'c1', mode: 'candidates', autoApprove: false, noteMaxLength: 300,
    connectionNotes: ['Hey {firstName}, would be great to connect.'],
    followUps: [], dailyCaps: { connects: 10, messages: 5, profileViews: 30 },
    workingHours: null, pauseBetweenActionsSec: [0, 0],
  };
  const invited = [];
  await runConnect(null, s, connectCfg, {
    ops: { sendConnectionRequest: async (p, url) => { invited.push(url); return { result: 'sent', info: {} }; } },
    pause: false,
  });
  assert.ok(invited.some(u => u.includes('/long')), 'the long stayer is invited');
  assert.ok(invited.some(u => u.includes('/unknown')), 'unknown tenure is still invited');
  assert.ok(!invited.some(u => u.includes('/short')), 'the short stayer is left alone');
  assert.equal(s.get('linkedin.com/in/short').status, 'new');

  // the InMail lane leaves them alone too, even though nothing invited them
  const s2 = new Store(path.join(home, `db-tenure2-${Math.random()}.json`));
  s2.data.meta.inmailApprovedAt = '2026-01-01T00:00:00.000Z';
  s2.data.meta.inmailBalance = 50;
  s2.upsertLead({ url: 'https://www.linkedin.com/talent/profile/SHORT', name: 'Short Stayer', campaign: 'c1', approved: true, degree: '2nd', tenureMonths: 5 });
  s2.save();
  const inmailCfg = {
    name: 'c1', autoApprove: false, dailyCaps: { profileViews: 30 },
    inmail: { subject: '{role}', body: 'Hi {firstName}.', monthlyCredits: 30, perDay: 10 },
    role: { title: 'Cloud Engineer', location: 'Dubai', workType: 'hybrid' },
    workingHours: null, pauseBetweenActionsSec: [0, 0],
  };
  const sentTo = [];
  const r = await runInMails({}, s2, inmailCfg, {
    ops: { sendRecruiterInMail: async (p, url) => { sentTo.push(url); return { sent: true, credits: { left: 49 } }; } },
    pause: false,
  });
  assert.equal(r.sent, 0);
  assert.deepEqual(sentTo, []);
});

const { isJunior, experienceMonths, tooJunior, DEFAULT_MIN_EXPERIENCE_MONTHS } = await import('../src/company.js');

test('intern and trainee titles are spotted, real senior titles are not', () => {
  for (const t of ['Security Intern', 'Summer Intern at Kraken', 'Graduate Programme', 'Cyber Trainee',
                   'Apprentice Engineer', 'Student at Imperial College', 'Industrial Placement']) {
    assert.equal(isJunior(t), true, t);
  }
  // real senior jobs that happen to contain one of those words
  for (const t of ['Principal Security Engineer', 'Internal Audit Lead', 'International Sales Director',
                   'Head of Student Services', 'Director of Undergraduate Admissions',
                   'Senior Cloud Security Engineer', '']) {
    assert.equal(isJunior(t), false, t);
  }
});

test('years of work are counted from the whole history, internships left out', () => {
  const now = new Date('2026-09-23T00:00:00Z');
  const h = [
    { term: 'Senior Security Engineer', duration: 'Jan 2022 - Present · 4 yrs 8 mos' },
    { term: 'Security Engineer', duration: 'Jun 2019 – Dec 2021 · 2 yrs 7 mos' },
    { term: 'Security Intern', duration: 'Jun 2018 – Sep 2018 · 4 mos' },
  ];
  // Jun 2019 to now, not 4y8m + 2y7m + the internship
  assert.equal(experienceMonths(h, now), 87);
  // only an internship on file: nothing commercial to count
  assert.equal(experienceMonths([{ term: 'Security Intern', duration: '4 mos' }], now), null);
  assert.equal(experienceMonths([], now), null);
});

test('only a clear case rules someone out as too junior', () => {
  assert.equal(tooJunior({ experienceMonths: 20 }), true);
  assert.equal(tooJunior({ experienceMonths: 40 }), false);
  assert.equal(tooJunior({ headline: 'Cyber Security Intern at Deloitte' }), true);
  assert.equal(tooJunior({ currentTitle: 'Graduate Scheme', experienceMonths: 99 }), true);
  // a card that hid older roles is not proof of anything
  assert.equal(tooJunior({ experienceMonths: 20, historyTruncated: true }), false);
  // nothing known is never a reason to drop someone
  assert.equal(tooJunior({}), false);
  // the bar is settable, and 0 turns it off
  assert.equal(tooJunior({ experienceMonths: 20 }, 12), false);
  assert.equal(tooJunior({ experienceMonths: 1 }, 0), false);
  assert.equal(DEFAULT_MIN_EXPERIENCE_MONTHS, 36);
});

test('an intern is not invited or InMailed', async () => {
  const { runConnect } = await import('../src/actions/connect.js');
  const s = new Store(path.join(home, `db-jr-${Math.random()}.json`));
  s.data.meta.ownName = 'Kai Crayford';
  s.upsertLead({ url: 'linkedin.com/in/sen', name: 'Senior Person', campaign: 'c1', approved: true, degree: '2nd', tenureMonths: 30, experienceMonths: 120 });
  s.upsertLead({ url: 'linkedin.com/in/jr', name: 'Junior Person', campaign: 'c1', approved: true, degree: '2nd', tenureMonths: 30, experienceMonths: 18 });
  s.upsertLead({ url: 'linkedin.com/in/int', name: 'Intern Person', campaign: 'c1', approved: true, degree: '2nd', tenureMonths: 30, experienceMonths: 120, currentTitle: 'Security Intern' });
  s.upsertLead({ url: 'linkedin.com/in/cut', name: 'Cut Short', campaign: 'c1', approved: true, degree: '2nd', tenureMonths: 30, experienceMonths: 18, historyTruncated: true });
  s.save();
  const cfg = {
    name: 'c1', mode: 'candidates', autoApprove: false, noteMaxLength: 300,
    connectionNotes: ['Hey {firstName}, would be great to connect.'],
    followUps: [], dailyCaps: { connects: 10, messages: 5, profileViews: 30 },
    workingHours: null, pauseBetweenActionsSec: [0, 0],
  };
  const invited = [];
  await runConnect(null, s, cfg, { ops: { sendConnectionRequest: async (p, url) => { invited.push(url); return { result: 'sent', info: {} }; } }, pause: false });
  assert.ok(invited.some(u => u.includes('/sen')), 'the senior person is invited');
  assert.ok(invited.some(u => u.includes('/cut')), 'a truncated history is not a reason to drop someone');
  assert.ok(!invited.some(u => u.includes('/jr')), 'under 3 years is left alone');
  assert.ok(!invited.some(u => u.includes('/int')), 'an intern is left alone');
});

const { SENIORITY, levelFromTitle, minExperienceFor, overLevelled } = await import('../src/company.js');

test('the level comes off the role title, and sets the years bar', () => {
  assert.equal(levelFromTitle('Head of Compliance'), 'lead');
  assert.equal(levelFromTitle('Lead Security Engineer'), 'lead');
  assert.equal(levelFromTitle('Principal Engineer'), 'lead');
  assert.equal(levelFromTitle('VP Engineering'), 'lead');
  assert.equal(levelFromTitle('Senior Cloud Security Engineer'), 'senior');
  assert.equal(levelFromTitle('Junior Analyst'), 'junior');
  assert.equal(levelFromTitle('Graduate Developer'), 'junior');
  assert.equal(levelFromTitle('Security Engineer'), 'mid');

  assert.equal(SENIORITY.junior.minYears, 1);
  assert.equal(SENIORITY.junior.maxYears, 2);
  assert.equal(SENIORITY.lead.minYears, 6);

  assert.equal(minExperienceFor({ role: { title: 'Lead Security Engineer' } }), 72);
  assert.equal(minExperienceFor({ role: { title: 'Senior Cloud Security Engineer' } }), 36);
  assert.equal(minExperienceFor({ seniority: 'junior', role: { title: 'Lead X' } }), 12);
  // a bar set by hand wins over the level
  assert.equal(minExperienceFor({ minExperienceMonths: 24, seniority: 'lead' }), 24);
  assert.equal(minExperienceFor({ minExperienceMonths: 0, seniority: 'lead' }), 0);
});

test('a lead role turns away five years, a senior role does not', () => {
  const five = { experienceMonths: 60 };
  assert.equal(tooJunior(five, minExperienceFor({ role: { title: 'Lead Security Engineer' } })), true);
  assert.equal(tooJunior(five, minExperienceFor({ role: { title: 'Senior Security Engineer' } })), false);
});

test('being past the level is a note, never a reason to drop someone', () => {
  const veteran = { experienceMonths: 120 };
  assert.equal(overLevelled(veteran, { seniority: 'junior' }), true);
  assert.equal(overLevelled(veteran, { seniority: 'lead' }), false);       // no top end on a lead role
  assert.equal(overLevelled({}, { seniority: 'junior' }), false);          // nothing known
  assert.equal(tooJunior(veteran, minExperienceFor({ seniority: 'junior' })), false);
});

// ---- what the audit on 23 Sep found. Each of these held a good person back, or hammered LinkedIn.

test('an ordinary senior headline is never read as an internship', () => {
  for (const t of [
    'Head of Cyber Security at Co-op', 'Senior Data Engineer, Co-op Group',
    'Security professional with 12 years of work experience', 'Apprenticeship Manager',
    'Head of Graduate Programme, Barclays', 'Graduate Program Director', 'Placement Manager',
    'Head of Placement', 'CISO | ex-intern turned leader', 'Director of Work Experience Programmes',
    'Head of Student Services', 'Security Engineer at Student Beans', 'International Sales Director',
  ]) assert.equal(isJunior(t), false, t);
  // and the real ones still are
  for (const t of ['Security Intern', 'Cyber Security Intern at Deloitte', 'Cyber Trainee',
                   'Apprentice Engineer', 'Student at Imperial College', 'Summer Analyst']) {
    assert.equal(isJunior(t), true, t);
  }
});

test('a CISO whose headline mentions a co-op is still contacted', () => {
  const ciso = { currentTitle: 'Chief Information Security Officer', headline: 'Head of Cyber Security at Co-op Group', experienceMonths: 240 };
  assert.equal(tooJunior(ciso, 72), false);
  // the title Recruiter gave us is believed before the free-text headline
  assert.equal(tooJunior({ currentTitle: 'Head of Security', headline: 'started as an intern' }, 36), false);
});

test('an employer name in the history does not wipe out their years', () => {
  const now = new Date('2026-09-23T00:00:00Z');
  const h = [{ term: 'Head of Data at Co-op', duration: 'Jan 2011 - Present · 15 yrs' },
             { term: 'Analyst', duration: 'Jan 2026 - Present · 8 mos' }];
  assert.ok(experienceMonths(h, now) > 180, 'fifteen years must not read as eight months');
});

test('years are counted to the end of their last job, not to today', () => {
  const now = new Date('2026-09-23T00:00:00Z');
  assert.equal(experienceMonths([{ term: 'Engineer', duration: 'Jan 2000 - Dec 2004 · 5 yrs' }], now), 60);
  // one role that started this month tells us nothing, so it must not hold anyone
  assert.equal(experienceMonths([{ term: 'Head of Security', duration: 'Sep 2026 - Present' }], now), null);
  assert.equal(tooJunior({ experienceMonths: experienceMonths([{ term: 'Head of Security', duration: 'Sep 2026 - Present' }], now) }, 36), false);
});

test('a duration is read off the current role when several are joined together', () => {
  assert.equal(tenureMonths('Jan 2015 - Present | Jan 2014 - Aug 2014 · 8 mos', new Date('2026-09-23T00:00:00Z')), 140);
  assert.equal(tenureMonths('2019 - 2021'), 24);
  assert.equal(tenureMonths('Jan 2023 − Present', new Date('2026-09-23T00:00:00Z')), 44);   // unicode minus
});

test('turning the years rule off still keeps interns out', () => {
  assert.equal(tooJunior({ currentTitle: 'Security Intern', experienceMonths: 4 }, 0), true);
  assert.equal(tooJunior({ experienceMonths: 4 }, 0), false);
});

test('Kai can overrule a hold, and the runners honour it', async () => {
  const { runConnect } = await import('../src/actions/connect.js');
  assert.equal(tooJunior({ currentTitle: 'Security Intern', holdOverride: true }, 36), false);
  assert.equal(tooNewInRole({ tenureMonths: 2, holdOverride: true }), false);
  const s = new Store(path.join(home, `db-ovr-${Math.random()}.json`));
  s.data.meta.ownName = 'Kai Crayford';
  s.upsertLead({ url: 'linkedin.com/in/ovr', name: 'Worth It', campaign: 'c1', approved: true, degree: '2nd', tenureMonths: 2, experienceMonths: 10, holdOverride: true });
  s.save();
  const invited = [];
  await runConnect(null, s, {
    name: 'c1', mode: 'candidates', autoApprove: false, noteMaxLength: 300,
    connectionNotes: ['Hey {firstName}.'], followUps: [], dailyCaps: { connects: 5, messages: 5, profileViews: 20 },
    workingHours: null, pauseBetweenActionsSec: [0, 0],
  }, { ops: { sendConnectionRequest: async (p, url) => { invited.push(url); return { result: 'sent', info: {} }; } }, pause: false });
  assert.equal(invited.length, 1);
});

test('a company that will not read is dropped after three tries, whichever key it came in on', async () => {
  const s = seed([{ name: 'A', company: 'Nowhere Ltd' }]);
  // the page is found but does not parse: the miss must stick to the key the queue uses
  const ops = { findCompanyPage: async () => 'https://www.linkedin.com/company/nowhere/', readCompanyAbout: async () => null };
  for (let i = 0; i < 3; i++) { await runCompanyLookups({}, s, cfg, { ops, pause: false }); s.load(); }
  assert.deepEqual(s.companiesToLookUp({ campaign: 'c1' }), [], 'three misses must stop the retries');
});

test('one employer is one row, however its name reached us', async () => {
  const s = seed([
    { name: 'A', company: 'Help AG', companyUrl: 'https://www.linkedin.com/company/help-ag/' },
    { name: 'B', company: 'Help AG' },
    { name: 'C', company: 'Rain' },
  ]);
  const queue = s.companiesToLookUp({ campaign: 'c1' });
  assert.deepEqual(queue.map(c => c.people), [2, 1], 'the two Help AG people count as one employer');
  const about = [];
  await runCompanyLookups({}, s, cfg, {
    pause: false,
    ops: {
      findCompanyPage: async (_p, name) => `https://www.linkedin.com/company/${name.toLowerCase().replace(/ /g, '-')}/`,
      readCompanyAbout: async (_p, u) => { about.push(u); return { sector: 'Security', size: { min: 201, max: 500, label: '201-500' }, sizeText: '201-500 employees' }; },
    },
  });
  assert.equal(about.filter(u => /help-ag/.test(u)).length, 1, 'looked up once, not twice');
  s.load();
  // both people can read the facts back
  assert.equal(s.companyFor(s.get('https://www.linkedin.com/in/p0')).sector, 'Security');
  assert.equal(s.companyFor(s.get('https://www.linkedin.com/in/p1')).sector, 'Security');
});

test('a lead from before any of this still gets contacted', () => {
  const old = { url: 'x', name: 'Old Record', status: 'new', approved: true, degree: '2nd' };
  assert.equal(tooNewInRole(old), false);
  assert.equal(tooJunior(old, 72), false);
});
