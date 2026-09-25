import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryFromSpec, ROLE_MESSAGE, LEGACY_INMAIL, LEGACY_FIRST_MESSAGE, upgradeOutreach } from '../src/outreach.js';
import { renderChecked } from '../src/template.js';

const aiSpec = `Systems & Research Engineer
Location: Global
About Example Lab
Example Lab is an applied AI lab building systems for freight and supply chains. Founded in 2025.
Key Responsibilities
Own performance and scale for model serving and voice infrastructure.
Run structured research: benchmark providers and compare cost and quality.
Requirements
Use coding agents daily.
Interview Process
Three interviews.`;

test('role pitch uses brief facts and updates when the role changes', () => {
  const summary = summaryFromSpec(aiSpec);
  assert.match(summary, /applied AI lab/);
  assert.match(summary, /performance and scale/);
  assert.match(summary, /benchmark providers/);
  assert.doesNotMatch(summary, /Three interviews|digital asset/);
  const lead = {firstName:'Alex'};
  const ai = renderChecked(ROLE_MESSAGE, lead, {title:'Systems & Research Engineer', location:'Global', outreachSummary:summary});
  assert.equal(ai.problem, '');
  assert.match(ai.text, /Hi Alex/);
  const other = renderChecked(ROLE_MESSAGE, lead, {title:'Nurse', location:'London', outreachSummary:'Care for patients in a community clinic.'});
  assert.match(other.text, /community clinic/);
  assert.doesNotMatch(other.text, /AI lab|freight|Systems & Research/);
});

test('legacy defaults upgrade but custom copy and sending settings survive', () => {
  const old = upgradeOutreach({inmail:{body:LEGACY_INMAIL,perDay:3},firstDegree:{message:LEGACY_FIRST_MESSAGE,followUpAfterDays:8}});
  assert.equal(old.inmail.body, ROLE_MESSAGE);
  assert.equal(old.inmail.perDay, 3);
  assert.equal(old.firstDegree.message, ROLE_MESSAGE);
  assert.equal(old.firstDegree.followUpAfterDays, 8);
  const custom = {inmail:{body:'My own copy'},firstDegree:{message:'My other copy'}};
  assert.deepEqual(upgradeOutreach(custom), custom);
});

test('missing summary does not invent a business sector or location', () => {
  const message = renderChecked(ROLE_MESSAGE, {firstName:'Alex'}, {title:'Engineer'});
  assert.equal(message.problem, '');
  assert.doesNotMatch(message.text, /digital asset|Location:|undefined|null/);
  assert.equal(summaryFromSpec('Title only without any sections'), '');
});

test('hiring company names and aliases cannot leak through generated or custom copy', () => {
  const role = {title:'Research Engineer',specText:aiSpec,company:'Example Lab',client:{name:'E3 Group',otherNames:['E3']},outreachSummary:'E3 Group is an applied AI lab. Own E3’s model infrastructure.'};
  const generated = renderChecked(ROLE_MESSAGE,{firstName:'Alex'},role);
  assert.equal(generated.problem,'');
  assert.match(generated.text,/applied AI lab/);
  assert.doesNotMatch(generated.text,/E3|Example Lab/);
  for(const template of ['Work at E3 Group','An opportunity with e3','Example Lab role','Work at {company}']) {
    const result=renderChecked(template,{firstName:'Alex',company:'E3 Group'},role);
    assert.match(result.problem,/confidential/);
    assert.equal(result.text,'');
  }
});

test('generic company headings still identify the named employer', () => {
  const spec='About the company\nAcme Labs is an AI business.\nResponsibilities\nBuild Acme Labs infrastructure.\nRequirements\nPython';
  const summary=summaryFromSpec(spec);
  assert.match(summary,/AI business/);
  assert.doesNotMatch(summary,/Acme Labs/i);
});

test('InMail send and queued messages block confidential identity', async () => {
  const {sendRecruiterInMail}=await import('../src/actions/inmail.js');
  const {dueMessage}=await import('../src/actions/followup.js');
  const role={company:'Example Lab'};
  const result=await sendRecruiterInMail(null,'https://www.linkedin.com/talent/profile/a',{subject:'Example Lab role',body:'Hello',rehearse:false,role});
  assert.equal(result.sent,false);
  assert.match(result.reason,/confidential/);
  const message=dueMessage({status:'messaged',queue:[{text:'Work at Example Lab'}]},{role});
  assert.match(message.problem,/confidential/);
});
