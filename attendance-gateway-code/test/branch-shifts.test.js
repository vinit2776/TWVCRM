'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  createAttendanceLogic, resolveShift, legacyShift, autoCheckoutTimestamp, autoCheckoutDue, dayEndTimestamp, mostCommonShift, effectivePunches,
  LAUNCH_DATE, BRANCH_SHIFT_RULES_FROM,
} = require('../attendance-logic');

const BRANCHES = [
  { name: 'LGF', shift_start: '09:30', shift_end: '18:30', half_saturdays: 1, sat_start: '09:30', sat_end: '13:30' },
  // Perungudi works every Saturday in full (its Saturday timings are ignored).
  { name: 'Perungudi', shift_start: '10:00', shift_end: '19:00', half_saturdays: 0, sat_start: '10:00', sat_end: '14:00' },
];
// The branch rules as they apply once they are in force everywhere, which is what most
// of these tests are about; the cut-off itself is exercised at the end of the file.
const RULES = { branches: BRANCHES, effectiveFrom: LAUNCH_DATE };
const NO_BRANCHES = { branches: [], effectiveFrom: LAUNCH_DATE };
const TUESDAY = '2026-11-10';
const HALF_SATURDAY = '2026-11-14'; // 2nd Saturday
const FULL_SATURDAY = '2026-11-07'; // 1st Saturday: a normal shift

const emp = (fields = {}) => ({ id: 'EMP-1', branch: 'LGF', shift_start: '09:30', shift_end: '18:30', shift_custom: 0, ...fields });
const p = (time, direction, fields = {}) => ({ timestamp: `${TUESDAY} ${time}:00`, direction, source: 'office', branch: '', ...fields });

test('follows their own branch when they have not punched in yet', () => {
  const shift = resolveShift(emp({ branch: 'Perungudi' }), TUESDAY, [], RULES);
  assert.deepEqual(shift, { start: '10:00', end: '19:00', source: 'branch', branch: 'Perungudi' });
});

test('someone at two branches works the hours of the branch they first punched in at', () => {
  const both = emp({ branch: JSON.stringify(['LGF', 'Perungudi']) });
  assert.equal(resolveShift(both, TUESDAY, [p('09:55', 'in', { branch: 'Perungudi' })], RULES).end, '19:00');
  assert.equal(resolveShift(both, TUESDAY, [p('09:25', 'in', { branch: 'LGF' })], RULES).end, '18:30');
  // No punch yet: their first listed branch.
  assert.equal(resolveShift(both, TUESDAY, [], RULES).branch, 'LGF');
});

test('a visiting day uses the branch visited, not their own', () => {
  const shift = resolveShift(emp(), TUESDAY, [p('10:00', 'in', { branch: 'Perungudi', deviation: 1 })], RULES);
  assert.equal(shift.branch, 'Perungudi');
  assert.equal(shift.end, '19:00');
});

test('a remote first punch falls back to their own branch', () => {
  const shift = resolveShift(emp({ branch: 'Perungudi' }), TUESDAY, [p('10:00', 'in', { source: 'remote', branch: '' })], RULES);
  assert.equal(shift.branch, 'Perungudi');
});

test('custom timings win on weekdays at any branch', () => {
  const custom = emp({ shift_custom: 1, shift_start: '11:00', shift_end: '20:00' });
  const shift = resolveShift(custom, TUESDAY, [p('11:00', 'in', { branch: 'Perungudi' })], RULES);
  assert.deepEqual(shift, { start: '11:00', end: '20:00', source: 'custom', branch: 'Perungudi' });
});

test('half Saturdays only at branches that have them (LGF); other branches work a full Saturday', () => {
  const sat = branch => [{ timestamp: `${HALF_SATURDAY} 10:00:00`, direction: 'in', source: 'office', branch }];
  assert.deepEqual(resolveShift(emp(), HALF_SATURDAY, sat('LGF'), RULES), { start: '09:30', end: '13:30', source: 'branch', branch: 'LGF' });
  assert.deepEqual(resolveShift(emp({ branch: 'Perungudi' }), HALF_SATURDAY, sat('Perungudi'), RULES), { start: '10:00', end: '19:00', source: 'branch', branch: 'Perungudi' });
  // LGF staff working the 2nd Saturday at Perungudi work Perungudi's full day.
  assert.equal(resolveShift(emp(), HALF_SATURDAY, sat('Perungudi'), RULES).end, '19:00');
  // 1st Saturday is a normal working day everywhere.
  assert.equal(resolveShift(emp(), FULL_SATURDAY, [], RULES).end, '18:30');
});

test('custom timings: LGF half Saturday still applies; a full Saturday uses their own hours', () => {
  const custom = emp({ shift_custom: 1, shift_start: '11:00', shift_end: '20:00' });
  const sat = branch => [{ timestamp: `${HALF_SATURDAY} 10:00:00`, direction: 'in', source: 'office', branch }];
  assert.equal(resolveShift(custom, HALF_SATURDAY, sat('LGF'), RULES).end, '13:30');
  assert.deepEqual(resolveShift(custom, HALF_SATURDAY, sat('Perungudi'), RULES), { start: '11:00', end: '20:00', source: 'custom', branch: 'Perungudi' });
});

test('a branch with no timings, or no branches at all, falls back to the employee, then the default', () => {
  assert.deepEqual(resolveShift(emp({ shift_start: '08:00', shift_end: '17:00' }), TUESDAY, [], NO_BRANCHES),
    { start: '08:00', end: '17:00', source: 'employee', branch: 'LGF' });
  assert.deepEqual(resolveShift({ branch: null }, TUESDAY, [], NO_BRANCHES), { start: '09:30', end: '18:30', source: 'default', branch: null });
  assert.deepEqual(resolveShift(emp(), HALF_SATURDAY, [], NO_BRANCHES), { start: '09:30', end: '13:30', source: 'default', branch: 'LGF' });
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
  assert.equal(autoCheckoutDue(e, TUESDAY, day, RULES, `${TUESDAY} 19:14:59`), null);
  assert.equal(autoCheckoutDue(e, TUESDAY, day, RULES, `${TUESDAY} 19:15:00`), `${TUESDAY} 19:15:00`);
  // A run hours later still stamps 19:15.
  assert.equal(autoCheckoutDue(e, TUESDAY, day, RULES, `${TUESDAY} 23:45:00`), `${TUESDAY} 19:15:00`);
  // LGF staff punching in at Perungudi get Perungudi's time.
  assert.equal(autoCheckoutDue(emp(), TUESDAY, day, RULES, `${TUESDAY} 23:00:00`), `${TUESDAY} 19:15:00`);
  assert.equal(autoCheckoutDue(emp(), TUESDAY, [p('09:20', 'in', { branch: 'LGF' })], RULES, `${TUESDAY} 23:00:00`), `${TUESDAY} 18:45:00`);
});

test('autoCheckoutDue: nothing to do for a closed day, a day already auto punched-out, or a late check-in', () => {
  const e = emp();
  const now = `${TUESDAY} 23:00:00`;
  assert.equal(autoCheckoutDue(e, TUESDAY, [], RULES, now), null);
  assert.equal(autoCheckoutDue(e, TUESDAY, [p('09:30', 'in'), p('18:30', 'out')], RULES, now), null);
  assert.equal(autoCheckoutDue(e, TUESDAY, [p('09:30', 'in'), p('18:45', 'out', { source: 'auto' })], RULES, now), null);
  assert.equal(autoCheckoutDue(e, TUESDAY, [p('19:30', 'in')], RULES, now), null);
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
function setupDb({ effectiveFrom = LAUNCH_DATE } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, shift_start TEXT NOT NULL, shift_end TEXT NOT NULL,
      shift_custom INTEGER NOT NULL DEFAULT 0, branch TEXT, date_joined TEXT);
    CREATE TABLE punches (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      direction TEXT NOT NULL, source TEXT NOT NULL, note TEXT DEFAULT '', location TEXT DEFAULT '', marked_by TEXT DEFAULT '',
      branch TEXT DEFAULT '', deviation INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE branches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, shift_start TEXT NOT NULL DEFAULT '',
      shift_end TEXT NOT NULL DEFAULT '', half_saturdays INTEGER NOT NULL DEFAULT 0, sat_start TEXT NOT NULL DEFAULT '', sat_end TEXT NOT NULL DEFAULT '');
    CREATE TABLE deviation_reviews (employee_id TEXT NOT NULL, date TEXT NOT NULL, decision TEXT NOT NULL, PRIMARY KEY (employee_id, date));
    CREATE TABLE holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE leave_requests (id INTEGER PRIMARY KEY, employee_id TEXT, leave_type TEXT, start_date TEXT, end_date TEXT, status TEXT);
    CREATE TABLE permission_requests (id INTEGER PRIMARY KEY, employee_id TEXT, date TEXT, leave_time TEXT, status TEXT);
    CREATE TABLE correction_requests (id INTEGER PRIMARY KEY, employee_id TEXT, date TEXT, kind TEXT, status TEXT);
    CREATE TABLE breaks (id INTEGER PRIMARY KEY, employee_id TEXT, start_ts TEXT, end_ts TEXT);
  `);
  for (const b of BRANCHES) {
    db.prepare('INSERT INTO branches (name, shift_start, shift_end, half_saturdays, sat_start, sat_end) VALUES (?, ?, ?, ?, ?, ?)').run(b.name, b.shift_start, b.shift_end, b.half_saturdays, b.sat_start, b.sat_end);
  }
  db.prepare("INSERT INTO employees (id, name, shift_start, shift_end, branch) VALUES ('EMP-1', 'Test', '09:30', '18:30', ?)").run(JSON.stringify(['LGF', 'Perungudi']));
  const add = (time, direction, source, branch = '', date = TUESDAY) => db.prepare('INSERT INTO punches (employee_id, timestamp, direction, source, branch) VALUES (?, ?, ?, ?, ?)')
    .run('EMP-1', `${date} ${time}:00`, direction, source, branch);
  // Most of these tests are about the branch rules themselves, so they run with the rules
  // in force from launch; the cut-off tests pass their own date.
  return { db, add, logic: createAttendanceLogic(db, { getShiftRulesEffectiveFrom: () => effectiveFrom }) };
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

// --- When a day is over, for closing a break the employee never resumed ---

test('dayEndTimestamp: nothing to close until the shift end has passed', () => {
  const punches = [p('09:25', 'in', { branch: 'LGF' })];
  assert.equal(dayEndTimestamp(emp(), TUESDAY, punches, RULES, `${TUESDAY} 17:00:00`), null);
  // 18:30 + 15.
  assert.equal(dayEndTimestamp(emp(), TUESDAY, punches, RULES, `${TUESDAY} 18:45:00`), `${TUESDAY} 18:45:00`);
});

test('dayEndTimestamp: a day that pairs up ends at its own punch-out, early or late', () => {
  const early = [p('09:25', 'in', { branch: 'LGF' }), p('17:00', 'out', { branch: 'LGF' })];
  const late = [p('09:25', 'in', { branch: 'LGF' }), p('20:30', 'out', { branch: 'LGF' })];
  const now = `${TUESDAY} 23:00:00`;
  assert.equal(dayEndTimestamp(emp(), TUESDAY, early, RULES, now), `${TUESDAY} 17:00:00`);
  assert.equal(dayEndTimestamp(emp(), TUESDAY, late, RULES, now), `${TUESDAY} 20:30:00`);
});

test('dayEndTimestamp: an open day ends at the auto punch-out time, per branch', () => {
  const now = `${TUESDAY} 23:00:00`;
  assert.equal(dayEndTimestamp(emp(), TUESDAY, [p('09:25', 'in', { branch: 'LGF' })], RULES, now), `${TUESDAY} 18:45:00`);
  assert.equal(
    dayEndTimestamp(emp({ branch: 'Perungudi' }), TUESDAY, [p('09:58', 'in', { branch: 'Perungudi' })], RULES, now),
    `${TUESDAY} 19:15:00`,
  );
});

test('dayEndTimestamp: punches read before the auto punch-out was recorded still give its time', () => {
  // performAutoCheckout passes the punches as it read them, so the day still looks open.
  const punches = [p('09:25', 'in', { branch: 'LGF' })];
  assert.equal(dayEndTimestamp(emp(), TUESDAY, punches, RULES, `${TUESDAY} 22:00:00`), `${TUESDAY} 18:45:00`);
});

test('dayEndTimestamp: a custom shift ends on its own hours', () => {
  const night = emp({ shift_custom: 1, shift_start: '06:00', shift_end: '08:00' });
  assert.equal(
    dayEndTimestamp(night, TUESDAY, [p('06:00', 'in', { branch: 'LGF' })], RULES, `${TUESDAY} 12:00:00`),
    `${TUESDAY} 08:15:00`,
  );
});


// --- The effective-from cut-off: a past day is read the way it was worked ---

test('legacyShift: own timings, and one company-wide half shift on the 2nd and 4th Saturday', () => {
  const perungudi = emp({ branch: 'Perungudi', shift_start: '10:00', shift_end: '19:00' });
  assert.deepEqual(legacyShift(perungudi, TUESDAY), { start: '10:00', end: '19:00', source: 'legacy', branch: null });
  // The branch does not come into it: Perungudi has half Saturdays off, but before the
  // rules existed every branch ran the company half shift.
  assert.deepEqual(legacyShift(perungudi, HALF_SATURDAY), { start: '09:30', end: '13:30', source: 'legacy', branch: null });
  assert.deepEqual(legacyShift(perungudi, FULL_SATURDAY), { start: '10:00', end: '19:00', source: 'legacy', branch: null });
  // Custom makes no difference either — the old rule only ever read the saved timings.
  assert.equal(legacyShift(emp({ shift_custom: 1, shift_start: '11:00', shift_end: '20:00' }), TUESDAY).end, '20:00');
  assert.deepEqual(legacyShift({ branch: 'LGF' }, TUESDAY), { start: '09:30', end: '18:30', source: 'legacy', branch: null });
});

test('resolveShift: the cut-off decides which rule a day gets', () => {
  const rules = { branches: BRANCHES, effectiveFrom: '2026-11-12' };
  const e = emp({ branch: 'Perungudi', shift_start: '09:30', shift_end: '18:30' });
  const punches = [p('09:58', 'in', { branch: 'Perungudi' })];
  // Before: their own saved timings, whatever branch they punched in at.
  assert.deepEqual(resolveShift(e, '2026-11-11', punches, rules), { start: '09:30', end: '18:30', source: 'legacy', branch: null });
  // On and after: Perungudi's.
  assert.deepEqual(resolveShift(e, '2026-11-12', punches, rules), { start: '10:00', end: '19:00', source: 'branch', branch: 'Perungudi' });
});

test('resolveShift: a past 2nd Saturday at a branch without half Saturdays stays a half day', () => {
  // The bug this cut-off exists for. Perungudi has half_saturdays 0, so under the branch
  // rules a 09:30-13:30 2nd Saturday is measured against a 19:00 finish and reads as a
  // Half Day. Before the rules were in force it was the company half shift, so it was a
  // full day's work and must keep reading that way.
  const e = emp({ branch: 'Perungudi', shift_start: '09:30', shift_end: '18:30' });
  const sat = [p('09:28', 'in', { branch: 'Perungudi' })];
  const future = { branches: BRANCHES, effectiveFrom: '2026-12-01' };
  assert.equal(resolveShift(e, HALF_SATURDAY, sat, future).end, '13:30');
  assert.equal(resolveShift(e, HALF_SATURDAY, sat, RULES).end, '19:00');
});

test('resolveShift: no cut-off, or an unusable one, reads every day the old way', () => {
  const e = emp({ branch: 'Perungudi' });
  const punches = [p('09:58', 'in', { branch: 'Perungudi' })];
  for (const effectiveFrom of [undefined, '', null, 'soon', '2026-13-45', '11/12/2026']) {
    assert.equal(resolveShift(e, TUESDAY, punches, { branches: BRANCHES, effectiveFrom }).source, 'legacy', String(effectiveFrom));
  }
  // Nothing at all, including no branch list: still the old rule, never a thrown error.
  assert.equal(resolveShift(e, TUESDAY, punches).source, 'legacy');
  assert.equal(resolveShift(e, TUESDAY, punches, {}).source, 'legacy');
  assert.equal(resolveShift(e, TUESDAY, punches, null).source, 'legacy');
});

test('the shipped cut-off leaves the gateway launch under the old rule', () => {
  assert.match(BRANCH_SHIFT_RULES_FROM, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(BRANCH_SHIFT_RULES_FROM > LAUNCH_DATE);
  const e = emp({ branch: 'Perungudi' });
  const live = { branches: BRANCHES };
  assert.equal(resolveShift(e, LAUNCH_DATE, [], live).source, 'legacy');
  assert.equal(resolveShift(e, BRANCH_SHIFT_RULES_FROM, [], live).source, 'branch');
});

test('auto punch-out follows the rule that applied that day', () => {
  // A day before the cut-off is due at the employee's own shift end + 15, not the
  // branch's — otherwise a catch-up sweep would stamp the wrong time on an old day.
  const e = emp({ branch: 'Perungudi', shift_start: '09:30', shift_end: '18:30' });
  const open = [p('09:58', 'in', { branch: 'Perungudi' })];
  const rules = { branches: BRANCHES, effectiveFrom: '2026-11-12' };
  const late = `${TUESDAY} 23:00:00`;
  assert.equal(autoCheckoutDue(e, TUESDAY, open, rules, late), `${TUESDAY} 18:45:00`);
  assert.equal(dayEndTimestamp(e, TUESDAY, open, rules, late), `${TUESDAY} 18:45:00`);
  assert.equal(autoCheckoutDue(e, TUESDAY, open, RULES, late), `${TUESDAY} 19:15:00`);
  assert.equal(dayEndTimestamp(e, TUESDAY, open, RULES, late), `${TUESDAY} 19:15:00`);
});

test('computeDayStatus: a past half Saturday at a full-Saturday branch stays a full day', async () => {
  // End to end, the day this cut-off is for. Perungudi works every Saturday in full, so
  // under the branch rules a 09:28-13:35 2nd Saturday is measured against a 19:00 finish
  // and comes out a Half Day. Worked before the rules existed it was the company half
  // shift — a full day — and it has to keep reading that way in a month already reported.
  const punch = (add) => {
    add('09:28', 'in', 'office', 'Perungudi', HALF_SATURDAY);
    add('13:35', 'out', 'office', 'Perungudi', HALF_SATURDAY);
  };
  const before = setupDb({ effectiveFrom: '2026-12-01' });
  punch(before.add);
  assert.equal((await before.logic.computeDayStatus('EMP-1', HALF_SATURDAY)).status, 'Present');

  const after = setupDb({ effectiveFrom: LAUNCH_DATE });
  punch(after.add);
  assert.equal((await after.logic.computeDayStatus('EMP-1', HALF_SATURDAY)).status, 'Half Day');
});
