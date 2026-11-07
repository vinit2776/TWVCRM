'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAttendanceLogic } = require('../attendance-logic');
const { createDailyReport, renderReportEmail, parseRecipients, sendEmail } = require('../daily-report');

const DAY = '2026-10-26'; // a Monday

// Fresh, isolated in-memory database per test — never touches the real attendance.db.
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE employees (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, shift_start TEXT NOT NULL, shift_end TEXT NOT NULL,
      onsite_enabled INTEGER NOT NULL DEFAULT 0, date_joined TEXT, branch TEXT
    );
    CREATE TABLE punches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      direction TEXT NOT NULL, source TEXT NOT NULL, note TEXT DEFAULT '', location TEXT DEFAULT '',
      marked_by TEXT DEFAULT '', branch TEXT DEFAULT '', deviation INTEGER NOT NULL DEFAULT 0
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
  const { buildReport } = createDailyReport(db, createAttendanceLogic(db));
  return { db, buildReport };
}
function employee(db, id, name, extra = {}) {
  db.prepare('INSERT INTO employees (id, name, shift_start, shift_end, branch, date_joined) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, name, extra.shiftStart || '09:30', extra.shiftEnd || '18:30', extra.branch || 'LGF', extra.dateJoined || null);
}
function punch(db, id, time, direction, source = 'biometric', branch = 'LGF') {
  db.prepare('INSERT INTO punches (employee_id, timestamp, direction, source, branch) VALUES (?, ?, ?, ?, ?)')
    .run(id, `${DAY} ${time}:00`, direction, source, branch);
}
const names = rows => rows.map(r => r.name);

test('morning: splits on time, late, not in yet and on leave, as of 10:00', async () => {
  const { db, buildReport } = setup();
  employee(db, 'E1', 'Anjali');
  employee(db, 'E2', 'Karan');
  employee(db, 'E3', 'Rohit');
  employee(db, 'E4', 'Farhan');
  employee(db, 'E5', 'Late Comer');
  employee(db, 'E6', 'New Joiner', { dateJoined: '2026-11-01' });
  punch(db, 'E1', '09:27', 'in', 'office', 'Arcade Center');
  punch(db, 'E2', '09:52', 'in');
  db.prepare("INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, status, requested_at) VALUES ('E4', 'Sick Leave', ?, ?, 'approved', ?)")
    .run(DAY, DAY, `${DAY} 08:00:00`);
  punch(db, 'E5', '10:20', 'in'); // after the cutoff: still "not in" at 10:00

  const r = await buildReport('morning', DAY);
  assert.deepEqual(names(r.onTime), ['Anjali']);
  assert.equal(r.onTime[0].branch, 'Arcade Center');
  assert.equal(r.onTime[0].source, 'App');
  assert.deepEqual(names(r.late), ['Karan']);
  assert.equal(r.late[0].lateBy, 22);
  assert.deepEqual(names(r.notIn), ['Late Comer', 'Rohit']);
  assert.deepEqual(names(r.onLeave), ['Farhan']);
  assert.equal(r.onLeave[0].leaveType, 'Sick Leave');
  assert.equal(r.total, 5); // New Joiner hasn't started yet
});

test('morning: inside the 15-minute grace is on time', async () => {
  const { db, buildReport } = setup();
  employee(db, 'E1', 'Deepak');
  punch(db, 'E1', '09:45', 'in');
  const r = await buildReport('morning', DAY);
  assert.deepEqual(names(r.onTime), ['Deepak']);
  assert.equal(r.late.length, 0);
});

test('evening: punched out, left early, still in and absent, ignoring the auto-checkout', async () => {
  const { db, buildReport } = setup();
  employee(db, 'E1', 'Anjali');
  employee(db, 'E2', 'Neha');
  employee(db, 'E3', 'Karan');
  employee(db, 'E4', 'Rohit');
  punch(db, 'E1', '09:27', 'in');
  punch(db, 'E1', '18:34', 'out');
  punch(db, 'E2', '09:48', 'in');
  punch(db, 'E2', '16:10', 'out');
  punch(db, 'E3', '09:52', 'in');
  punch(db, 'E3', '19:00', 'out', 'auto'); // the 7 PM timer already ran: still counts as "still in"

  const r = await buildReport('evening', DAY);
  assert.deepEqual(names(r.out), ['Anjali']);
  assert.equal(Math.round(r.out[0].workedMinutes), 9 * 60 + 7);
  assert.deepEqual(names(r.leftEarly), ['Neha']);
  assert.deepEqual(names(r.stillIn), ['Karan']);
  assert.deepEqual(names(r.absent), ['Rohit']);
});

test('evening: an approved early-leave permission is not "left early"; breaks come off the hours', async () => {
  const { db, buildReport } = setup();
  employee(db, 'E1', 'Sneha');
  punch(db, 'E1', '09:30', 'in');
  punch(db, 'E1', '16:00', 'out');
  db.prepare("INSERT INTO permission_requests (employee_id, date, leave_time, status, requested_at) VALUES ('E1', ?, '16:00', 'approved', ?)")
    .run(DAY, `${DAY} 08:00:00`);
  db.prepare('INSERT INTO breaks (employee_id, start_ts, end_ts) VALUES (?, ?, ?)').run('E1', `${DAY} 13:00:00`, `${DAY} 13:30:00`);
  const r = await buildReport('evening', DAY);
  assert.deepEqual(names(r.out), ['Sneha']);
  assert.equal(Math.round(r.out[0].workedMinutes), 6 * 60);
});

test('evening: a check-out after 19:00 is not counted (snapshot as of 7 PM)', async () => {
  const { db, buildReport } = setup();
  employee(db, 'E1', 'Imran');
  punch(db, 'E1', '09:30', 'in');
  punch(db, 'E1', '19:25', 'out');
  const r = await buildReport('evening', DAY);
  assert.deepEqual(names(r.stillIn), ['Imran']);
});

test('no report on a holiday or a Sunday', async () => {
  const { db, buildReport } = setup();
  db.prepare('INSERT INTO holidays (date, name) VALUES (?, ?)').run(DAY, 'Diwali');
  assert.equal((await buildReport('morning', DAY)).skipped, 'Holiday: Diwali');
  assert.equal((await buildReport('evening', '2026-10-25')).skipped, 'Sunday');
});

test('email: subject names the report and day, and employee names are escaped', async () => {
  const { db, buildReport } = setup();
  employee(db, 'E1', '<b>Mallory</b>');
  const { subject, html, text } = renderReportEmail(await buildReport('morning', DAY));
  assert.equal(subject, 'Punch-in report · Mon, 26 Oct 2026 · 10:00 AM');
  assert.ok(html.includes('&lt;b&gt;Mallory&lt;/b&gt;'));
  assert.ok(!html.includes('<b>Mallory</b>'));
  assert.ok(text.includes('Not punched in yet (1)'));
});

test('email: warns when the biometric device is offline', async () => {
  const { buildReport } = setup();
  const { html } = renderReportEmail(await buildReport('evening', DAY), { deviceOfflineSince: `${DAY} 17:05` });
  assert.ok(html.includes("hasn't reached the app since 2026-10-26 17:05"));
});

test('parseRecipients: commas, spaces or new lines; rejects anything that is not an address', () => {
  assert.deepEqual(parseRecipients('a@x.com, b@y.co\nc@z.in'), ['a@x.com', 'b@y.co', 'c@z.in']);
  assert.deepEqual(parseRecipients(''), []);
  assert.equal(parseRecipients('a@x.com, vinit'), null);
});

test('sendEmail: posts to Resend with the key, and throws on an error response', async () => {
  let call;
  const ok = async (url, init) => { call = { url, init }; return { ok: true, json: async () => ({ id: 'em_1' }) }; };
  const id = await sendEmail({ apiKey: 're_test', from: 'A <a@x.com>', to: ['b@y.com'], subject: 'S', html: '<p>h</p>', text: 't' }, ok);
  assert.equal(id, 'em_1');
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.equal(call.init.headers.Authorization, 'Bearer re_test');
  assert.deepEqual(JSON.parse(call.init.body).to, ['b@y.com']);

  const bad = async () => ({ ok: false, status: 403, text: async () => 'domain not verified' });
  await assert.rejects(sendEmail({ apiKey: 'k', from: 'f', to: ['b@y.com'], subject: 's', html: 'h', text: 't' }, bad), /Resend 403: domain not verified/);
});
