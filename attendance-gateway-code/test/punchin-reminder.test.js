'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAttendanceLogic } = require('../attendance-logic');
const { createPunchinReminder, renderReminderEmail, reminderWindow } = require('../punchin-reminder');

const DAY = '2026-10-26'; // a Monday
const at = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Fresh, isolated in-memory database per test — never touches the real attendance.db.
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE employees (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, shift_start TEXT NOT NULL, shift_end TEXT NOT NULL,
      onsite_enabled INTEGER NOT NULL DEFAULT 0, date_joined TEXT, branch TEXT, email TEXT
    );
    CREATE TABLE punches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      direction TEXT NOT NULL, source TEXT NOT NULL, note TEXT DEFAULT ''
    );
    CREATE TABLE holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, leave_type TEXT NOT NULL,
      start_date TEXT NOT NULL, end_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
    );
  `);
  const addEmp = (id, name, start, email = `${id}@example.com`, extra = {}) =>
    db.prepare('INSERT INTO employees (id, name, shift_start, shift_end, email, date_joined) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, start, '18:30', email, extra.dateJoined || null);
  const punch = (id, ts, source = 'biometric') =>
    db.prepare("INSERT INTO punches (employee_id, timestamp, direction, source) VALUES (?, ?, 'in', ?)").run(id, ts, source);
  const { dueReminders } = createPunchinReminder(db, createAttendanceLogic(db));
  return { db, addEmp, punch, dueReminders };
}

test('reminds a 09:30 employee with no punch at 09:40', async () => {
  const { addEmp, dueReminders } = setup();
  addEmp('E1', 'Priya Sharma', '09:30');
  const { due } = await dueReminders(DAY, at('09:40'), 'fixed');
  assert.equal(due.length, 1);
  assert.equal(due[0].email, 'E1@example.com');
  assert.equal(due[0].remindAt, at('09:40'));
  assert.equal(due[0].graceEnd, at('09:45'));
});

test('nothing before the reminder time or once grace has ended', async () => {
  const { addEmp, dueReminders } = setup();
  addEmp('E1', 'Priya', '09:30');
  assert.equal((await dueReminders(DAY, at('09:39'), 'fixed')).due.length, 0);
  assert.equal((await dueReminders(DAY, at('09:44'), 'fixed')).due.length, 1);
  assert.equal((await dueReminders(DAY, at('09:45'), 'fixed')).due.length, 0);
});

test('skips people who punched in, are on leave, have no email or have not joined', async () => {
  const { db, addEmp, punch, dueReminders } = setup();
  addEmp('IN', 'Already In', '09:30');
  addEmp('LV', 'On Leave', '09:30');
  addEmp('NE', 'No Email', '09:30', '');
  addEmp('NJ', 'Not Joined', '09:30', 'nj@example.com', { dateJoined: '2026-11-01' });
  addEmp('OK', 'Gets One', '09:30');
  punch('IN', `${DAY} 09:20:00`);
  db.prepare("INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, status) VALUES ('LV', 'Casual', ?, ?, 'approved')").run(DAY, DAY);
  const { due } = await dueReminders(DAY, at('09:41'), 'fixed');
  assert.deepEqual(due.map(d => d.employeeId), ['OK']);
});

test('an auto-checkout punch does not count as punched in', async () => {
  const { addEmp, punch, dueReminders } = setup();
  addEmp('E1', 'Priya', '09:30');
  punch('E1', `${DAY} 00:00:01`, 'auto');
  assert.equal((await dueReminders(DAY, at('09:40'), 'fixed')).due.length, 1);
});

test('fixed window: a 10:00 shift (reminder 10:10) gets nothing', async () => {
  const { addEmp, dueReminders } = setup();
  addEmp('E1', 'Rahul', '10:00');
  const { due } = await dueReminders(DAY, at('10:10'), 'fixed');
  assert.equal(due.length, 0);
});

test('shifts window: a 10:00 shift is reminded at 10:10 with its own grace end', async () => {
  const { addEmp, dueReminders } = setup();
  addEmp('E1', 'Priya', '09:30');
  addEmp('E2', 'Rahul', '10:00');
  const early = await dueReminders(DAY, at('09:40'), 'shifts');
  assert.deepEqual(early.due.map(d => d.employeeId), ['E1']);
  const late = await dueReminders(DAY, at('10:10'), 'shifts');
  assert.deepEqual(late.due.map(d => d.employeeId), ['E2']);
  assert.equal(late.due[0].graceEnd, at('10:15'));
  assert.deepEqual(late.window, { start: at('09:30'), end: at('10:15') });
});

test('no reminders on Sundays or holidays', async () => {
  const { db, addEmp, dueReminders } = setup();
  addEmp('E1', 'Priya', '09:30');
  assert.ok((await dueReminders('2026-10-25', at('09:40'), 'fixed')).skipped);
  db.prepare("INSERT INTO holidays (date, name) VALUES (?, 'Diwali')").run(DAY);
  assert.match((await dueReminders(DAY, at('09:40'), 'fixed')).skipped, /Diwali/);
});

test('2nd Saturday uses the short shift start', async () => {
  const { addEmp, dueReminders } = setup();
  addEmp('E1', 'Rahul', '10:00'); // normal 10:00, but 2nd Saturday runs 09:30-13:30
  const { due } = await dueReminders('2026-11-14', at('09:40'), 'fixed');
  assert.equal(due.length, 1);
  assert.equal(due[0].shiftStart, '09:30');
});

test('reminderWindow: fixed is 09:30-10:00, shifts spans earliest start to latest grace end', () => {
  assert.deepEqual(reminderWindow('fixed', [at('11:00')]), { start: at('09:30'), end: at('10:00') });
  assert.deepEqual(reminderWindow('shifts', [at('09:30'), at('11:00')]), { start: at('09:30'), end: at('11:15') });
  assert.equal(reminderWindow('shifts', []), null);
});

test('email uses first name, the per-shift times and punch-in wording', () => {
  const email = renderReminderEmail({ name: 'Rahul Mehta', remindAt: at('10:10'), graceEnd: at('10:15') }, { appUrl: 'https://twv-attendance.vercel.app' });
  assert.equal(email.subject, 'Reminder to punch-in.');
  assert.match(email.html, /Hi Rahul,/);
  assert.match(email.html, /ends at <strong>10:15 AM<\/strong>/);
  assert.match(email.html, /recorded for you by 10:10 AM/);
  assert.match(email.html, /Punch in now/);
  assert.match(email.text, /grace period ends at 10:15 AM/);
  assert.doesNotMatch(email.html + email.text, /check.in/i);
});

test('email escapes the name', () => {
  const email = renderReminderEmail({ name: '<b>x</b>', remindAt: at('09:40'), graceEnd: at('09:45') });
  assert.doesNotMatch(email.html, /<b>x<\/b>/);
});
