'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  createAttendanceLogic, resolveShift, autoCheckoutTimestamp, autoCheckoutDue, mostCommonShift, effectivePunches,
} = require('../attendance-logic');

const BRANCHES = [
  { name: 'LGF', shift_start: '09:30', shift_end: '18:30', sat_start: '09:30', sat_end: '13:30' },
  { name: 'Perungudi', shift_start: '10:00', shift_end: '19:00', sat_start: '10:00', sat_end: '14:00' },
];
const TUESDAY = '2026-11-10';
const HALF_SATURDAY = '2026-11-14'; // 2nd Saturday
const FULL_SATURDAY = '2026-11-07'; // 1st Saturday: a normal shift

const emp = (fields = {}) => ({ id: 'EMP-1', branch: 'LGF', shift_start: '09:30', shift_end: '18:30', shift_custom: 0, ...fields });
const p = (time, direction, fields = {}) => ({ timestamp: `${TUESDAY} ${time}:00`, direction, source: 'office', branch: '', ...fields });

test('follows their own branch when they have not punched in yet', () => {
  const shift = resolveShift(emp({ branch: 'Perungudi' }), TUESDAY, [], BRANCHES);
  assert.deepEqual(shift, { start: '10:00', end: '19:00', source: 'branch', branch: 'Perungudi' });
});

test('someone at two branches works the hours of the branch they first punched in at', () => {
  const both = emp({ branch: JSON.stringify(['LGF', 'Perungudi']) });
  assert.equal(resolveShift(both, TUESDAY, [p('09:55', 'in', { branch: 'Perungudi' })], BRANCHES).end, '19:00');
  assert.equal(resolveShift(both, TUESDAY, [p('09:25', 'in', { branch: 'LGF' })], BRANCHES).end, '18:30');
  // No punch yet: their first listed branch.
  assert.equal(resolveShift(both, TUESDAY, [], BRANCHES).branch, 'LGF');
});

test('a visiting day uses the branch visited, not their own', () => {
  const shift = resolveShift(emp(), TUESDAY, [p('10:00', 'in', { branch: 'Perungudi', deviation: 1 })], BRANCHES);
  assert.equal(shift.branch, 'Perungudi');
  assert.equal(shift.end, '19:00');
});

test('a remote first punch falls back to their own branch', () => {
  const shift = resolveShift(emp({ branch: 'Perungudi' }), TUESDAY, [p('10:00', 'in', { source: 'remote', branch: '' })], BRANCHES);
  assert.equal(shift.branch, 'Perungudi');
});

test('custom timings win on weekdays at any branch', () => {
  const custom = emp({ shift_custom: 1, shift_start: '11:00', shift_end: '20:00' });
  const shift = resolveShift(custom, TUESDAY, [p('11:00', 'in', { branch: 'Perungudi' })], BRANCHES);
  assert.deepEqual(shift, { start: '11:00', end: '20:00', source: 'custom', branch: 'Perungudi' });
});

test('half Saturdays follow the branch, even for custom timings', () => {
  const custom = emp({ shift_custom: 1, shift_start: '11:00', shift_end: '20:00' });
  const sat = [{ timestamp: `${HALF_SATURDAY} 10:00:00`, direction: 'in', source: 'office', branch: 'Perungudi' }];
  assert.deepEqual(resolveShift(custom, HALF_SATURDAY, sat, BRANCHES), { start: '10:00', end: '14:00', source: 'branch', branch: 'Perungudi' });
  // 1st Saturday is a normal working day.
  assert.equal(resolveShift(emp(), FULL_SATURDAY, [], BRANCHES).end, '18:30');
});

test('a branch with no timings, or no branches at all, falls back to the employee, then the default', () => {
  assert.deepEqual(resolveShift(emp({ shift_start: '08:00', shift_end: '17:00' }), TUESDAY, [], []),
    { start: '08:00', end: '17:00', source: 'employee', branch: 'LGF' });
  assert.deepEqual(resolveShift({ branch: null }, TUESDAY, [], []), { start: '09:30', end: '18:30', source: 'default', branch: null });
  assert.deepEqual(resolveShift(emp(), HALF_SATURDAY, [], []), { start: '09:30', end: '13:30', source: 'default', branch: 'LGF' });
});

test('auto punch-out is 15 minutes after the shift end', () => {
  assert.equal(autoCheckoutTimestamp(TUESDAY, { end: '19:00' }), `${TUESDAY} 19:15:00`);
  assert.equal(autoCheckoutTimestamp(TUESDAY, { end: '13:30' }), `${TUESDAY} 13:45:00`);
  // Never spills into the next day.
  assert.equal(autoCheckoutTimestamp(TUESDAY, { end: '23:50' }), `${TUESDAY} 23:59:00`);
});

test('autoCheckoutDue: due only once the time has passed, stamped at the due time', () => {
  const day = [p('09:58', 'in', { branch: 'Perungudi' })];
  const e = emp({ branch: 'Perungudi' });
  assert.equal(autoCheckoutDue(e, TUESDAY, day, BRANCHES, `${TUESDAY} 19:14:59`), null);
  assert.equal(autoCheckoutDue(e, TUESDAY, day, BRANCHES, `${TUESDAY} 19:15:00`), `${TUESDAY} 19:15:00`);
  // A run hours later still stamps 19:15.
  assert.equal(autoCheckoutDue(e, TUESDAY, day, BRANCHES, `${TUESDAY} 23:45:00`), `${TUESDAY} 19:15:00`);
  // LGF staff punching in at Perungudi get Perungudi's time.
  assert.equal(autoCheckoutDue(emp(), TUESDAY, day, BRANCHES, `${TUESDAY} 23:00:00`), `${TUESDAY} 19:15:00`);
  assert.equal(autoCheckoutDue(emp(), TUESDAY, [p('09:20', 'in', { branch: 'LGF' })], BRANCHES, `${TUESDAY} 23:00:00`), `${TUESDAY} 18:45:00`);
});

test('autoCheckoutDue: nothing to do for a closed day, a day already auto punched-out, or a late check-in', () => {
  const e = emp();
  const now = `${TUESDAY} 23:00:00`;
  assert.equal(autoCheckoutDue(e, TUESDAY, [], BRANCHES, now), null);
  assert.equal(autoCheckoutDue(e, TUESDAY, [p('09:30', 'in'), p('18:30', 'out')], BRANCHES, now), null);
  assert.equal(autoCheckoutDue(e, TUESDAY, [p('09:30', 'in'), p('18:45', 'out', { source: 'auto' })], BRANCHES, now), null);
  assert.equal(autoCheckoutDue(e, TUESDAY, [p('19:30', 'in')], BRANCHES, now), null);
});

test('a real punch-out after the auto punch-out replaces it (app or a late device sync)', () => {
  const day = [p('09:30', 'in'), p('18:45', 'out', { source: 'auto' }), p('20:30', 'out', { source: 'biometric' })];
  const used = effectivePunches(day);
  assert.deepEqual(used.map(x => x.timestamp.slice(11, 16)), ['09:30', '20:30']);
});

test('mostCommonShift picks the timings most employees work', () => {
  assert.deepEqual(mostCommonShift([
    { shift_start: '10:00', shift_end: '19:00' }, { shift_start: '10:00', shift_end: '19:00' }, { shift_start: '09:30', shift_end: '18:30' },
  ]), { start: '10:00', end: '19:00' });
  assert.equal(mostCommonShift([]), null);
});

// End to end through computeDayStatus, with the branches table in the db.
function setupDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, shift_start TEXT NOT NULL, shift_end TEXT NOT NULL,
      shift_custom INTEGER NOT NULL DEFAULT 0, branch TEXT, date_joined TEXT);
    CREATE TABLE punches (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      direction TEXT NOT NULL, source TEXT NOT NULL, note TEXT DEFAULT '', location TEXT DEFAULT '', marked_by TEXT DEFAULT '',
      branch TEXT DEFAULT '', deviation INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE branches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, shift_start TEXT NOT NULL DEFAULT '',
      shift_end TEXT NOT NULL DEFAULT '', sat_start TEXT NOT NULL DEFAULT '', sat_end TEXT NOT NULL DEFAULT '');
    CREATE TABLE deviation_reviews (employee_id TEXT NOT NULL, date TEXT NOT NULL, decision TEXT NOT NULL, PRIMARY KEY (employee_id, date));
    CREATE TABLE holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE leave_requests (id INTEGER PRIMARY KEY, employee_id TEXT, leave_type TEXT, start_date TEXT, end_date TEXT, status TEXT);
    CREATE TABLE permission_requests (id INTEGER PRIMARY KEY, employee_id TEXT, date TEXT, leave_time TEXT, status TEXT);
    CREATE TABLE correction_requests (id INTEGER PRIMARY KEY, employee_id TEXT, date TEXT, kind TEXT, status TEXT);
    CREATE TABLE breaks (id INTEGER PRIMARY KEY, employee_id TEXT, start_ts TEXT, end_ts TEXT);
  `);
  for (const b of BRANCHES) {
    db.prepare('INSERT INTO branches (name, shift_start, shift_end, sat_start, sat_end) VALUES (?, ?, ?, ?, ?)').run(b.name, b.shift_start, b.shift_end, b.sat_start, b.sat_end);
  }
  db.prepare("INSERT INTO employees (id, name, shift_start, shift_end, branch) VALUES ('EMP-1', 'Test', '09:30', '18:30', ?)").run(JSON.stringify(['LGF', 'Perungudi']));
  const add = (time, direction, source, branch = '') => db.prepare('INSERT INTO punches (employee_id, timestamp, direction, source, branch) VALUES (?, ?, ?, ?, ?)')
    .run('EMP-1', `${TUESDAY} ${time}:00`, direction, source, branch);
  return { db, add, logic: createAttendanceLogic(db) };
}

test('computeDayStatus uses the punched-in branch: leaving at 18:40 from Perungudi is a Half Day', async () => {
  const { add, logic } = setupDb();
  add('09:58', 'in', 'office', 'Perungudi');
  add('18:40', 'out', 'office', 'Perungudi');
  const status = await logic.computeDayStatus('EMP-1', TUESDAY);
  assert.equal(status.status, 'Half Day');
});

test('computeDayStatus: the same times at LGF are a full day', async () => {
  const { add, logic } = setupDb();
  add('09:28', 'in', 'office', 'LGF');
  add('18:40', 'out', 'office', 'LGF');
  assert.equal((await logic.computeDayStatus('EMP-1', TUESDAY)).status, 'Present');
});

test('computeDayStatus: a manual punch-out after the auto one clears the Missed Checkout', async () => {
  const { add, logic } = setupDb();
  add('09:58', 'in', 'office', 'Perungudi');
  add('19:15', 'out', 'auto');
  assert.equal((await logic.computeDayStatus('EMP-1', TUESDAY)).status, 'Missed Checkout');
  add('20:30', 'out', 'office', 'Perungudi');
  const status = await logic.computeDayStatus('EMP-1', TUESDAY);
  assert.equal(status.status, 'Present');
  assert.equal(status.checkOut, `${TUESDAY} 20:30:00`);
});
