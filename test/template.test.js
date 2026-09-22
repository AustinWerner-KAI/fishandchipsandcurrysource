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
