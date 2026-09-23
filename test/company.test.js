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
