'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  ACTIONS, ACTIVITY_CATEGORIES, activityLabel, categoryOf, describeDevice, activityFilterSql, ACTIVITY_CSV_HEADERS, activityCsvRow,
} = require('../activity-log');

test('every logged action belongs to a real category', () => {
  const keys = ACTIVITY_CATEGORIES.map(c => c.key);
  for (const [action, def] of Object.entries(ACTIONS)) assert.ok(keys.includes(def.category), action);
  assert.equal(categoryOf('punch_in'), 'attendance');
  assert.equal(categoryOf('something_new'), 'other');
});

test('activityLabel reads employee events and admin actions in plain words', () => {
  assert.equal(activityLabel({ category: 'sign_in', action: 'login_failed' }), 'Login failed');
  assert.equal(activityLabel({ category: 'attendance', action: 'punch_out' }), 'Punch out');
  assert.equal(activityLabel({ category: 'admin', action: 'approve', target_type: 'leave_request' }), 'Approved leave');
  assert.equal(activityLabel({ category: 'admin', action: 'reject', target_type: 'field_trip' }), 'Rejected field trip');
  assert.equal(activityLabel({ category: 'admin', action: 'download_report', target_type: 'muster_report' }), 'Downloaded Muster report');
  assert.equal(activityLabel({ category: 'admin', action: 'deviation_absent', target_type: 'deviation' }), 'Reviewed deviation');
  assert.equal(activityLabel({ category: 'admin', action: 'change_employee_id', target_type: 'employee' }), 'Changed Emp ID #');
  // An admin action added later without a label still reads sensibly.
  assert.equal(activityLabel({ category: 'admin', action: 'archive_branch', target_type: 'branches' }), 'Archive branch');
});

test('describeDevice tells phones from computers without detail beyond that', () => {
  assert.equal(describeDevice('Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36'), 'Android phone · Chrome');
  assert.equal(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
  assert.equal(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0'), 'Windows computer · Edge');
  assert.equal(describeDevice('curl/8.4'), 'Other device');
  assert.equal(describeDevice(''), '');
});

test('activityFilterSql filters by employee, category and inclusive dates, ignoring junk', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE activity_log (id INTEGER PRIMARY KEY, created_at TEXT, category TEXT, action TEXT, employee_id TEXT)');
  const insert = db.prepare('INSERT INTO activity_log (created_at, category, action, employee_id) VALUES (?, ?, ?, ?)');
  insert.run('2026-10-14 23:59:59', 'attendance', 'punch_out', 'EMP-005');
  insert.run('2026-10-15 00:00:00', 'sign_in', 'login', 'EMP-005');
  insert.run('2026-10-15 18:30:00', 'attendance', 'punch_out', 'EMP-005');
  insert.run('2026-10-15 18:31:00', 'attendance', 'punch_out', 'EMP-027');
  insert.run('2026-10-16 00:00:00', 'attendance', 'punch_in', 'EMP-005');
  const count = (filters) => {
    const { where, args } = activityFilterSql(filters);
    return db.prepare(`SELECT COUNT(*) AS c FROM activity_log ${where}`).get(...args).c;
  };
  assert.equal(count({}), 5);
  assert.equal(count({ from: '2026-10-15', to: '2026-10-15' }), 3);
  assert.equal(count({ from: '2026-10-15', to: '2026-10-15', employeeId: 'EMP-005' }), 2);
  assert.equal(count({ from: '2026-10-15', to: '2026-10-15', category: 'attendance' }), 2);
  assert.equal(count({ category: 'not-a-category', from: "2026-10-15' OR 1=1 --" }), 5);
});

test('activityCsvRow lines up with the CSV headers', () => {
  const row = activityCsvRow({
    created_at: '2026-10-15 09:28:00', category: 'attendance', action: 'punch_in', employee_id: 'EMP-005',
    actor_username: '', actor_role: 'device', details: 'Punch time 2026-10-15 09:28:00 · Biometric device', user_agent: '', ip: '',
  }, 'Prema R');
  assert.equal(row.length, ACTIVITY_CSV_HEADERS.length);
  assert.deepEqual(row.slice(0, 7), ['2026-10-15 09:28:00', 'EMP-005', 'Prema R', '', 'device', 'Punches and breaks', 'Punch in']);
});
