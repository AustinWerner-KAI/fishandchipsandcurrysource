import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, checkNote } from '../src/template.js';

test('render fills tags, both brace styles, and cleans up blanks', () => {
  const lead = { firstName: 'Jane', name: 'Jane Doe', company: 'Acme' };
  assert.equal(render('Hey {firstName}, would be great to connect.', lead), 'Hey Jane, would be great to connect.');
  assert.equal(render('Hey [Name], how is {company}?', lead), 'Hey Jane, how is Acme?');
  assert.equal(render('Hey {firstName}, would be great to connect.', {}), 'Hey, would be great to connect.');
  assert.equal(render('', lead), '');
});

test('checkNote flags length and dashes', () => {
  assert.deepEqual(checkNote('fine'), []);
  assert.deepEqual(checkNote('x'.repeat(301)), ['too long (301/300)']);
  assert.deepEqual(checkNote('no — dashes'), ['contains a dash']);
  assert.deepEqual(checkNote(''), ['empty']);
});

test('role tags: {role} {location} {workType}, case-insensitive, {rolename} and {firstname} accepted', () => {
  const role = { title: 'Senior Cloud Security Engineer', location: 'New York', workType: 'hybrid', candidateLocations: ['New York'] };
  const lead = { firstName: 'Ana' };
  assert.equal(render('Hey {firstname}, in {location}. {workType}.', lead, role), 'Hey Ana, in New York. Hybrid, in the office part of the week.');
  assert.equal(render('Hey {firstName}, I have a new role, {role}, you might like.', lead, role), 'Hey Ana, I have a new role, Senior Cloud Security Engineer, you might like.');
  assert.equal(render('{rolename} / {WORKTYPE}', lead, { ...role, workType: 'remote', candidateLocations: ['UK', 'UAE'] }), 'Senior Cloud Security Engineer / Fully remote');
  assert.equal(render('{location}', lead, { ...role, workType: 'remote', candidateLocations: ['UK', 'UAE'] }), 'UK / UAE');
  assert.equal(render('{role} x', lead), 'x');
});
