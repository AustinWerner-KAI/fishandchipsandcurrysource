import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withinWorkingHours, humanPauseMs, startOfLocalDay, remaining, pick } from '../src/limits.js';

const hours = { start: '09:30', end: '18:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Dubai' };

test('working hours in Dubai', () => {
  // Tue 22 Sep 2026 10:00 Dubai = 06:00Z
  assert.equal(withinWorkingHours(hours, new Date('2026-09-22T06:00:00Z')), true);
  // 09:00 Dubai, before start
  assert.equal(withinWorkingHours(hours, new Date('2026-09-22T05:00:00Z')), false);
  // 18:00 Dubai, end is exclusive
  assert.equal(withinWorkingHours(hours, new Date('2026-09-22T14:00:00Z')), false);
  // Saturday
  assert.equal(withinWorkingHours(hours, new Date('2026-09-26T08:00:00Z')), false);
  assert.equal(withinWorkingHours(null, new Date()), true);
});

test('start of local day', () => {
  const d = startOfLocalDay(new Date('2026-09-22T06:00:00Z'), 'Asia/Dubai');
  assert.equal(d.toISOString(), '2026-09-21T20:00:00.000Z');
  const late = startOfLocalDay(new Date('2026-09-22T21:30:00Z'), 'Asia/Dubai'); // 01:30 on the 23rd in Dubai
  assert.equal(late.toISOString(), '2026-09-22T20:00:00.000Z');
});

test('remaining respects today only', () => {
  const store = {
    actionsSince: (since, type) => [
      { at: '2026-09-22T05:00:00.000Z', type: 'connects' },
      { at: '2026-09-21T10:00:00.000Z', type: 'connects' },
    ].filter(a => a.at >= since && a.type === type),
  };
  assert.equal(remaining(store, { connects: 3 }, 'connects', new Date('2026-09-22T06:00:00Z'), 'Asia/Dubai'), 2);
  assert.equal(remaining(store, {}, 'nothing', new Date('2026-09-22T06:00:00Z'), 'Asia/Dubai'), 0);
});

test('human pause stays inside its range', () => {
  for (let i = 0; i < 500; i++) {
    const ms = humanPauseMs([45, 180]);
    assert.ok(ms >= 45000 && ms <= 180000, String(ms));
  }
  assert.equal(pick([]), undefined);
  assert.equal(pick(['a']), 'a');
});
