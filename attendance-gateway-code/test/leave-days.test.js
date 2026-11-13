'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { countLeaveDaysInRange } = require('../attendance-logic');

// 2026-11-09 is a Monday, so 09-15 Nov is a full Mon-Sun week.
const MON = '2026-11-09';
const SUN = '2026-11-15';

test('a single working day is one leave day', () => {
  assert.equal(countLeaveDaysInRange(MON, MON), 1);
});

test('a Sunday inside the span is not a leave day', () => {
  // Mon-Sun is seven calendar days but six working ones — the Sunday was never owed.
  assert.equal(countLeaveDaysInRange(MON, SUN), 6);
});

test('a span that is only a Sunday costs nothing', () => {
  assert.equal(countLeaveDaysInRange(SUN, SUN), 0);
});

test('a declared holiday inside the span is not a leave day', () => {
  const holidays = new Set(['2026-11-11']); // a Wednesday
  assert.equal(countLeaveDaysInRange(MON, SUN, holidays), 5);
});

test('a holiday falling on the Sunday is not double-counted', () => {
  assert.equal(countLeaveDaysInRange(MON, SUN, new Set([SUN])), 6);
});

test('Saturdays count, including the short 2nd and 4th ones', () => {
  // 14 Nov 2026 is the 2nd Saturday: a working day on a shorter shift, so leave
  // taken on it is still leave. See resolveShift / isHalfSaturday.
  assert.equal(countLeaveDaysInRange('2026-11-14', '2026-11-14'), 1);
  assert.equal(countLeaveDaysInRange('2026-11-13', '2026-11-14'), 2);
});

test('holidays outside the span are ignored', () => {
  assert.equal(countLeaveDaysInRange(MON, '2026-11-10', new Set(['2026-11-25'])), 2);
});

test('a span crossing a month boundary counts both halves', () => {
  // 30 Nov 2026 (Mon) to 2 Dec (Wed): three working days, no Sunday between them.
  assert.equal(countLeaveDaysInRange('2026-11-30', '2026-12-02'), 3);
});

test('a long span counts every Sunday out', () => {
  // 2 Nov (Mon) to 29 Nov (Sun) is 28 days holding four Sundays.
  assert.equal(countLeaveDaysInRange('2026-11-02', '2026-11-29'), 24);
});
