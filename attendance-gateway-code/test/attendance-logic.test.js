'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAttendanceLogic, todayStr } = require('../attendance-logic');

const EMP = 'EMP-TEST';

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Fresh, isolated in-memory database per test — never touches the real attendance.db.
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE employees (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, shift_start TEXT NOT NULL, shift_end TEXT NOT NULL,
      onsite_enabled INTEGER NOT NULL DEFAULT 0, date_joined TEXT
    );
    CREATE TABLE punches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      direction TEXT NOT NULL, source TEXT NOT NULL, note TEXT DEFAULT '', location TEXT DEFAULT '',
      marked_by TEXT DEFAULT ''
    );
    CREATE TABLE holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, leave_type TEXT NOT NULL,
      start_date TEXT NOT NULL, end_date TEXT NOT NULL, reason TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', requested_at TEXT NOT NULL, decided_at TEXT
    );
    CREATE TABLE permission_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, date TEXT NOT NULL,
      leave_time TEXT NOT NULL, reason TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT NOT NULL, decided_at TEXT
    );
    CREATE TABLE breaks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL,
      start_ts TEXT NOT NULL, end_ts TEXT
    );
  `);
  db.prepare('INSERT INTO employees (id, name, shift_start, shift_end) VALUES (?, ?, ?, ?)')
    .run(EMP, 'Test Employee', '09:30', '18:30');
  const logic = createAttendanceLogic(db);
  return { db, ...logic };
}

function punch(db, dateStr, inTime, outTime) {
  db.prepare('INSERT INTO punches (employee_id, timestamp, direction, source) VALUES (?, ?, ?, ?)')
    .run(EMP, `${dateStr} ${inTime}`, 'in', 'biometric');
  if (outTime) {
    db.prepare('INSERT INTO punches (employee_id, timestamp, direction, source) VALUES (?, ?, ?, ?)')
      .run(EMP, `${dateStr} ${outTime}`, 'out', 'biometric');
  }
}

test('holiday: no punches on a holiday date returns Holiday with the holiday name', async () => {
  const { db, computeDayStatus } = setup();
  db.prepare('INSERT INTO holidays (date, name) VALUES (?, ?)').run('2026-08-11', 'Independence Day');
  const result = await computeDayStatus(EMP, '2026-08-11');
  assert.equal(result.status, 'Holiday');
  assert.equal(result.label, 'Independence Day');
});

test('week off: no punches on a Sunday returns Week Off', async () => {
  const { computeDayStatus } = setup();
  const result = await computeDayStatus(EMP, '2026-08-02'); // confirmed Sunday
  assert.equal(result.status, 'Week Off');
});

test('on leave: no punches on a date covered by an approved leave returns On Leave', async () => {
  const { db, computeDayStatus } = setup();
  db.prepare(
    'INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(EMP, 'Casual Leave', '2026-08-12', '2026-08-13', 'approved', '2026-08-01 10:00:00');
  const result = await computeDayStatus(EMP, '2026-08-12');
  assert.equal(result.status, 'On Leave');
  assert.equal(result.label, 'Casual Leave');
});

test('pre-launch fallback: no punches before LAUNCH_DATE returns Present, not Absent', async () => {
  const { computeDayStatus } = setup();
  const result = await computeDayStatus(EMP, '2026-07-01'); // before LAUNCH_DATE (2026-07-29)
  assert.equal(result.status, 'Present');
});

test('pre-employment fallback: no punches before the employee\'s own date_joined returns Present, not Absent', async () => {
  const { db, computeDayStatus } = setup();
  // Joined well after LAUNCH_DATE, so the pre-launch fallback above doesn't cover this —
  // this is the employee's own join date being the reason there's no attendance data.
  db.prepare('UPDATE employees SET date_joined = ? WHERE id = ?').run('2026-08-15', EMP);
  const result = await computeDayStatus(EMP, '2026-08-05');
  assert.equal(result.status, 'Present');
});

test('post-employment regression: no punches on a weekday on/after date_joined still returns Absent', async () => {
  const { db, computeDayStatus } = setup();
  db.prepare('UPDATE employees SET date_joined = ? WHERE id = ?').run('2026-07-30', EMP);
  // Same date as the plain "absent" test above (Thu, post-launch weekday) — joining on
  // this exact day shouldn't excuse an absence starting the day they were hired.
  const result = await computeDayStatus(EMP, '2026-07-30');
  assert.equal(result.status, 'Absent');
});

test('future date: no punches on a future date returns Upcoming', async () => {
  const { computeDayStatus } = setup();
  const result = await computeDayStatus(EMP, '2035-01-01');
  assert.equal(result.status, 'Upcoming');
});

test('absent: no punches on a past, post-launch weekday returns Absent', async () => {
  const { computeDayStatus } = setup();
  // Fixed past, post-launch weekday (Thu 2026-07-30) rather than daysAgo(1), which
  // lands on a Sunday every Monday and would (correctly) return Week Off, not Absent.
  const result = await computeDayStatus(EMP, '2026-07-30');
  assert.equal(result.status, 'Absent');
});

test('late: check-in after shift start + grace returns Late', async () => {
  const { db, computeDayStatus } = setup();
  const d = daysAgo(1);
  punch(db, d, '09:50:00', '18:30:00'); // shift starts 09:30, grace 15min — 09:50 is late
  const result = await computeDayStatus(EMP, d);
  assert.equal(result.status, 'Late');
  assert.equal(result.late, true);
});

test('half day: check-out before shift end - grace returns Half Day', async () => {
  const { db, computeDayStatus } = setup();
  const d = daysAgo(1);
  punch(db, d, '09:30:00', '17:00:00'); // shift ends 18:30, grace 5min — 17:00 is a half day
  const result = await computeDayStatus(EMP, d);
  assert.equal(result.status, 'Half Day');
  assert.equal(result.halfDay, true);
});

test('half day excused by permission: approved early-leave permission excuses the Half Day flag', async () => {
  const { db, computeDayStatus } = setup();
  const d = daysAgo(1);
  punch(db, d, '09:30:00', '17:00:00');
  db.prepare(
    'INSERT INTO permission_requests (employee_id, date, leave_time, status, requested_at) VALUES (?, ?, ?, ?, ?)'
  ).run(EMP, d, '17:00', 'approved', '2026-08-01 10:00:00');
  const result = await computeDayStatus(EMP, d);
  assert.equal(result.status, 'Present');
  assert.equal(result.halfDay, false);
});

test('Saturday half-shift: 2nd Saturday uses the shortened shift, not the normal one', async () => {
  const { db, computeDayStatus } = setup();
  const d = '2026-08-08'; // confirmed 2nd Saturday of August 2026
  punch(db, d, '09:30:00', '13:30:00'); // matches the half-shift window exactly
  const result = await computeDayStatus(EMP, d);
  // If this incorrectly used the employee's normal 09:30-18:30 shift, a 13:30 checkout
  // would falsely trigger Half Day — this asserts the half-shift override actually applies.
  assert.equal(result.status, 'Present');
  assert.equal(result.halfDay, false);
  assert.equal(result.hoursWorked, 4);
});

test('punch error: an odd punch count on a past date returns Punch Error', async () => {
  const { db, computeDayStatus } = setup();
  const d = daysAgo(1);
  punch(db, d, '09:30:00', null); // check-in with no matching check-out
  const result = await computeDayStatus(EMP, d);
  assert.equal(result.status, 'Punch Error');
});

test('active: an odd punch count on today returns Active', async () => {
  const { db, computeDayStatus } = setup();
  const today = todayStr();
  punch(db, today, '09:30:00', null);
  const result = await computeDayStatus(EMP, today);
  assert.equal(result.status, 'Active');
});

test('break: a completed break is subtracted from hoursWorked', async () => {
  const { db, computeDayStatus } = setup();
  const d = daysAgo(1);
  punch(db, d, '09:30:00', '18:30:00'); // 9h shift, exactly on time
  db.prepare('INSERT INTO breaks (employee_id, start_ts, end_ts) VALUES (?, ?, ?)')
    .run(EMP, `${d} 13:00:00`, `${d} 13:30:00`); // 30-minute lunch break
  const result = await computeDayStatus(EMP, d);
  assert.equal(result.status, 'Present');
  assert.equal(result.breakMinutes, 30);
  assert.equal(result.hoursWorked, 8.5);
});

test('break: an open break on today is reported as onBreak with a breakStart', async () => {
  const { db, computeDayStatus } = setup();
  const today = todayStr();
  punch(db, today, '09:30:00', null);
  db.prepare('INSERT INTO breaks (employee_id, start_ts) VALUES (?, ?)').run(EMP, `${today} 12:00:00`);
  const result = await computeDayStatus(EMP, today);
  assert.equal(result.status, 'Active');
  assert.equal(result.onBreak, true);
  assert.equal(result.breakStart, `${today} 12:00:00`);
});

function rawPunch(db, dateStr, time, direction, source) {
  db.prepare('INSERT INTO punches (employee_id, timestamp, direction, source) VALUES (?, ?, ?, ?)')
    .run(EMP, `${dateStr} ${time}`, direction, source);
}

test('auto-checkout: closes a day the employee forgot to punch out of', async () => {
  const { db, computeDayStatus } = setup();
  const d = daysAgo(1);
  rawPunch(db, d, '09:30:00', 'in', 'biometric');
  rawPunch(db, d, '19:00:00', 'out', 'auto');
  const result = await computeDayStatus(EMP, d);
  assert.equal(result.status, 'Present');
  assert.equal(result.checkOut, `${d} 19:00:00`);
  assert.equal(result.checkOutAuto, true);
});

test('auto-checkout: a real check-out that arrived after the auto-checkout wins, not Punch Error', async () => {
  const { db, computeDayStatus } = setup();
  const d = daysAgo(1);
  // Device buffered the 18:30 check-out and only uploaded it after the 19:00 auto-checkout
  // ran — the Surya 2026-09-28 case. Inserted in arrival order, labelled as it was then.
  rawPunch(db, d, '09:30:00', 'in', 'biometric');
  rawPunch(db, d, '19:00:00', 'out', 'auto');
  rawPunch(db, d, '18:30:00', 'in', 'biometric');
  const result = await computeDayStatus(EMP, d);
  assert.equal(result.status, 'Present');
  assert.equal(result.checkOut, `${d} 18:30:00`);
  assert.equal(result.checkOutAuto, false);
  assert.equal(result.hoursWorked, 9);
});

test('auto-checkout: a real punch after the auto-checkout is still a Punch Error', async () => {
  const { db, computeDayStatus } = setup();
  const d = daysAgo(1);
  // in / out / in-again at 19:30 — the 19:00 auto-checkout predates the open check-in,
  // so it can't close it.
  rawPunch(db, d, '09:30:00', 'in', 'biometric');
  rawPunch(db, d, '13:00:00', 'out', 'biometric');
  rawPunch(db, d, '19:00:00', 'out', 'auto');
  rawPunch(db, d, '19:30:00', 'in', 'biometric');
  const result = await computeDayStatus(EMP, d);
  assert.equal(result.status, 'Punch Error');
});
