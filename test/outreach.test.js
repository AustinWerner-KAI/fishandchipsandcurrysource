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
