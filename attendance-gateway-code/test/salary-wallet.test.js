'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dailyRate, computeSalaryWallet } = require('../salary-wallet');

// November 2026: 30 days, the 1st is a Sunday.
const YEAR = 2026, MONTH = 11;
const LEAVE = { types: ['Casual Leave', 'Sick Leave'], cap: 1 };
const date = d => `2026-11-${String(d).padStart(2, '0')}`;
const isSunday = d => new Date(YEAR, MONTH - 1, d).getDay() === 0;

// A month of statuses: every date up to `today` defaults to Present (Week Off on
// Sundays), later dates to Upcoming. `overrides` replaces single days.
function month(today, overrides = {}) {
  const days = [];
  for (let d = 1; d <= 30; d++) {
    const base = d > today ? { status: 'Upcoming' } : isSunday(d) ? { status: 'Week Off' } : { status: 'Present' };
    days.push({ date: date(d), ...base, ...(overrides[d] || {}) });
  }
  return days;
}
function wallet(today, overrides, extra = {}) {
  return computeSalaryWallet({ monthlySalary: 30000, year: YEAR, month: MONTH, today: date(today), days: month(today, overrides), monthlyPaidLeave: LEAVE, ...extra });
}
const outcomeOf = (w, d) => w.blocks[d - 1].outcome;

test('daily rate is salary divided by the calendar days in the month', () => {
  assert.equal(dailyRate(30000, 2026, 11), 1000);
  assert.equal(dailyRate(31000, 2026, 12), 1000);
  assert.equal(dailyRate(28000, 2026, 2), 1000);
});

test('a perfect month so far keeps the full salary, with Sundays paid', () => {
  const w = wallet(30);
  assert.equal(w.takeHome, 30000);
  assert.equal(w.secured, 30000);
  assert.equal(w.lost, 0);
  assert.equal(outcomeOf(w, 1), 'paid');
  assert.equal(outcomeOf(w, 2), 'secured');
});

test('Late counts as a full day', () => {
  const w = wallet(10, { 3: { status: 'Late' } });
  assert.equal(outcomeOf(w, 3), 'secured');
  assert.equal(w.lost, 0);
});

test('a half day keeps half and loses half', () => {
  const w = wallet(10, { 5: { status: 'Half Day' } });
  assert.equal(outcomeOf(w, 5), 'half');
  assert.equal(w.blocks[4].secured, 500);
  assert.equal(w.blocks[4].lost, 500);
  assert.equal(w.takeHome, 29500);
});

test('an absence loses the whole day', () => {
  const w = wallet(10, { 6: { status: 'Absent' } });
  assert.equal(outcomeOf(w, 6), 'lost');
  assert.equal(w.takeHome, 29000);
});

test('holidays are paid', () => {
  const w = wallet(10, { 4: { status: 'Holiday', label: 'Diwali' } });
  assert.equal(outcomeOf(w, 4), 'paid');
  assert.equal(w.lost, 0);
});

test('leave past the monthly paid allowance is lost; Comp Off is always paid', () => {
  const w = wallet(10, {
    3: { status: 'On Leave', label: 'Casual Leave' },
    4: { status: 'On Leave', label: 'Casual Leave' },
    5: { status: 'On Leave', label: 'Sick Leave' },
    6: { status: 'On Leave', label: 'Comp Off' },
    7: { status: 'On Leave', label: 'Comp Off' },
  });
  assert.equal(outcomeOf(w, 3), 'paid');
  assert.equal(outcomeOf(w, 4), 'lost');
  assert.equal(outcomeOf(w, 5), 'paid');
  assert.equal(outcomeOf(w, 6), 'paid');
  assert.equal(outcomeOf(w, 7), 'paid');
  assert.equal(w.lost, 1000);
});

test('a missed check-out counts as a half day until it is corrected', () => {
  const w = wallet(10, { 3: { status: 'Missed Checkout' } });
  assert.equal(outcomeOf(w, 3), 'half');
  assert.equal(w.lost, 500);
});

test('punch errors and pending branch reviews are on hold', () => {
  const w = wallet(10, {
    4: { status: 'Punch Error' },
    5: { status: 'Present', deviation: 'pending' },
  });
  for (const d of [4, 5]) {
    assert.equal(outcomeOf(w, d), 'hold');
    assert.equal(w.blocks[d - 1].secured, 0);
    assert.equal(w.blocks[d - 1].lost, 0);
  }
  assert.equal(w.takeHome, 30000);
});

test('a decided branch review uses the decided status', () => {
  const w = wallet(10, { 3: { status: 'Half Day', deviation: 'half_day' }, 4: { status: 'Present', deviation: 'accepted' } });
  assert.equal(outcomeOf(w, 3), 'half');
  assert.equal(outcomeOf(w, 4), 'secured');
});

test('today stays open until the day is done', () => {
  assert.equal(outcomeOf(wallet(11, { 11: { status: 'Absent' } }), 11), 'today');
  assert.equal(outcomeOf(wallet(11, { 11: { status: 'Active' } }), 11), 'today');
  assert.equal(outcomeOf(wallet(11, { 11: { status: 'Present' } }), 11), 'secured');
  assert.equal(outcomeOf(wallet(11, { 11: { status: 'Half Day' } }), 11), 'half');
  const w = wallet(11, { 11: { status: 'Absent' } });
  assert.equal(w.lost, 0);
  assert.equal(w.todayBlock.day, 11);
});

test('later days are upcoming and count toward neither total', () => {
  const w = wallet(11, { 11: { status: 'Active' } });
  assert.equal(outcomeOf(w, 12), 'upcoming');
  assert.equal(w.secured, 10000);
  assert.equal(w.takeHome, 30000);
});

test('days before the join date are left out of the month', () => {
  const w = wallet(10, {}, { dateJoined: date(6) });
  for (const d of [1, 2, 3, 4, 5]) assert.equal(outcomeOf(w, d), 'not_joined');
  assert.equal(outcomeOf(w, 6), 'secured');
  assert.equal(w.takeHome, 25000);
  assert.equal(w.lost, 0);
});

test('the streak counts present days back from the latest finished day', () => {
  // 5th half day, then 6, 7, 9, 10 present (8 is a Sunday), today the 11th in progress.
  const w = wallet(11, { 5: { status: 'Half Day' }, 11: { status: 'Active' } });
  assert.equal(w.streak, 4);
});

test('the streak skips days on hold and resets on an absence', () => {
  assert.equal(wallet(10, { 9: { status: 'Punch Error' } }).streak, 7);
  assert.equal(wallet(11, { 10: { status: 'Absent' }, 11: { status: 'Active' } }).streak, 0);
});
