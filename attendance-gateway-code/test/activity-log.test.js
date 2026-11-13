'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  ACTIONS, ACTIVITY_CATEGORIES, activityLabel, categoryOf, describeDevice, activityFilterSql, ACTIVITY_CSV_HEADERS, activityCsvRow,
  fieldChanges, parseChanges, changesText, activitySentence, sentenceText, detailsShown, changesAndDetails,
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

const NAMES = { 'EMP-005': 'Prema R', 'EMP-012': 'Rahul Sharma', 'EMP-001': 'Priya Mehta' };
const ACCOUNTS = { priya: 'EMP-001', 'EMP-005': 'EMP-005', 'EMP-012': 'EMP-012', amit: '' };
const lookups = { employeeName: (id) => NAMES[id] || '', accountEmployee: (u) => ACCOUNTS[u] || '' };
const say = (row) => sentenceText(activitySentence(row, lookups));

test('activityCsvRow lines up with the CSV headers', () => {
  const row = activityCsvRow({
    created_at: '2026-10-15 09:28:00', category: 'attendance', action: 'punch_in', employee_id: 'EMP-005',
    actor_username: '', actor_role: 'device', details: 'Punch time 2026-10-15 09:28:00 · Biometric device', user_agent: '', ip: '',
  }, lookups);
  assert.equal(row.length, ACTIVITY_CSV_HEADERS.length);
  assert.deepEqual(row.slice(0, 5), ['2026-10-15 09:28:00', 'Biometric device punched in Prema R', 'Punch time 2026-10-15 09:28:00 · Biometric device', 'EMP-005', 'Prema R']);
});

test('the CSV puts recorded changes in place of the short details', () => {
  const row = activityCsvRow({
    created_at: '2026-11-13 11:42:00', category: 'admin', action: 'edit_employee', employee_id: 'EMP-012',
    actor_username: 'priya', actor_role: 'admin', details: 'Rahul Sharma',
    changes: JSON.stringify([{ field: 'Branch', from: 'LGF', to: 'LGF, Arcade Center' }]),
  }, lookups);
  assert.equal(row[1], "Priya Mehta (admin) edited Rahul Sharma's details");
  assert.equal(row[2], 'Branch: LGF → LGF, Arcade Center');
});

// --- what an edit changed -----------------------------------------------------------

test('fieldChanges keeps only fields whose value changed, treating blank and null alike', () => {
  assert.deepEqual(fieldChanges([
    { label: 'Name', from: 'Rahul Sharma', to: 'Rahul Sharma' },
    { label: 'Email', from: null, to: '' },
    { label: 'Designation', from: '  Associate ', to: 'Associate' },
    { label: 'Reports to', from: 'Amit Verma', to: 'Neha Kapoor' },
    { label: 'Mobile', from: '', to: '9876543210' },
  ]), [
    { field: 'Reports to', from: 'Amit Verma', to: 'Neha Kapoor' },
    { field: 'Mobile', from: '(none)', to: '9876543210' },
  ]);
  // A form saved untouched records "nothing changed", not "not recorded".
  assert.deepEqual(fieldChanges([{ label: 'Name', from: 'A', to: 'A' }]), []);
});

test('a secret is marked changed but its values are never stored', () => {
  const list = fieldChanges([{ label: 'Punch API key', from: 'old-secret-123', to: 'new-secret-456', hidden: true }]);
  assert.deepEqual(list, [{ field: 'Punch API key', hidden: true }]);
  assert.ok(!JSON.stringify(list).includes('secret-'));
  assert.equal(changesText(JSON.stringify(list)), 'Punch API key: changed (value hidden)');
  // Unchanged secrets leave no trace at all.
  assert.deepEqual(fieldChanges([{ label: 'Punch API key', from: 'same', to: 'same', hidden: true }]), []);
});

test('parseChanges tells old entries (nothing recorded) from edits with no changes', () => {
  assert.equal(parseChanges(''), null);
  assert.equal(parseChanges(undefined), null);
  assert.equal(parseChanges('not json'), null);
  assert.deepEqual(parseChanges('[]'), []);
  assert.equal(changesText(JSON.stringify([
    { field: 'Arcade Center shift', from: '09:30–18:30', to: '10:00–19:00' },
    { field: 'Andheri', note: 'deleted' },
  ])), 'Arcade Center shift: 09:30–18:30 → 10:00–19:00; Andheri: deleted');
});

// --- one line saying who did what ---------------------------------------------------

test('employee actions read as the person doing them', () => {
  assert.equal(say({ category: 'attendance', action: 'punch_in', employee_id: 'EMP-012', actor_username: 'EMP-012', actor_role: 'employee' }), 'Rahul Sharma punched in');
  assert.equal(say({ category: 'sign_in', action: 'login', employee_id: 'EMP-012', actor_username: 'EMP-012', actor_role: 'employee' }), 'Rahul Sharma logged in');
  assert.equal(say({ category: 'request', action: 'leave_applied', employee_id: 'EMP-005', actor_username: 'EMP-005', actor_role: 'employee' }), 'Prema R applied for leave');
  assert.equal(say({ category: 'attendance', action: 'break_end', employee_id: 'EMP-005', actor_username: 'EMP-005', actor_role: 'employee' }), 'Prema R ended their break');
});

test('the device, the auto punch-out and managers are named as who did it', () => {
  assert.equal(say({ category: 'attendance', action: 'punch_in', employee_id: 'EMP-005', actor_username: '', actor_role: 'device' }), 'Biometric device punched in Prema R');
  assert.equal(say({ category: 'attendance', action: 'punch_out', employee_id: 'EMP-005', actor_username: '', actor_role: 'system' }), 'System punched out Prema R');
  assert.equal(say({ category: 'attendance', action: 'punch_in', employee_id: 'EMP-005', actor_username: 'priya', actor_role: 'admin' }), 'Priya Mehta (admin) punched in Prema R');
});

test('an admin acting on their own record is not named twice', () => {
  // priya's login belongs to EMP-001, so this is her own punch.
  assert.equal(say({ category: 'attendance', action: 'punch_in', employee_id: 'EMP-001', actor_username: 'priya', actor_role: 'admin' }), 'Priya Mehta punched in');
});

test('admin actions say who did what to whom', () => {
  const by = { category: 'admin', actor_username: 'priya', actor_role: 'admin' };
  assert.equal(say({ ...by, action: 'approve', target_type: 'leave_request', employee_id: 'EMP-012' }), "Priya Mehta (admin) approved Rahul Sharma's leave");
  assert.equal(say({ ...by, action: 'reject', target_type: 'field_trip', employee_id: 'EMP-005' }), "Priya Mehta (admin) rejected Prema R's field trip");
  assert.equal(say({ ...by, action: 'download_report', target_type: 'muster_report' }), 'Priya Mehta (admin) downloaded the Muster report');
  assert.equal(say({ ...by, action: 'settings_updated', target_type: 'app_settings' }), 'Priya Mehta (admin) updated settings');
  assert.equal(say({ ...by, action: 'add_employee', target_type: 'employee', employee_id: 'EMP-012' }), 'Priya Mehta (admin) registered Rahul Sharma');
  assert.equal(say({ ...by, action: 'deviation_absent', target_type: 'deviation', employee_id: 'EMP-005' }), "Priya Mehta (admin) reviewed Prema R's deviation");
  // A manager with no employee record shows their username.
  assert.equal(say({ category: 'admin', actor_username: 'amit', actor_role: 'manager', action: 'edit_employee', target_type: 'employee', employee_id: 'EMP-005' }), "amit (manager) edited Prema R's details");
  // The built-in admin account isn't named twice.
  assert.equal(say({ category: 'admin', actor_username: 'admin', actor_role: 'admin', action: 'settings_updated', target_type: 'app_settings' }), 'Admin updated settings');
  // An admin action added later without a sentence still reads sensibly.
  assert.equal(say({ ...by, action: 'archive_branch', target_type: 'branches' }), 'Priya Mehta (admin) archive branch');
});

test('an edit saved untouched says so; an old edit entry just says it was edited', () => {
  const edit = { category: 'admin', action: 'edit_employee', target_type: 'employee', employee_id: 'EMP-012', actor_username: 'priya', actor_role: 'admin' };
  assert.equal(say({ ...edit, changes: '[]' }), "Priya Mehta (admin) saved Rahul Sharma's details with no changes");
  assert.equal(say({ ...edit, changes: '' }), "Priya Mehta (admin) edited Rahul Sharma's details");
  // The name the old entry stored as its details is already in the sentence.
  assert.equal(detailsShown({ ...edit, details: 'Rahul Sharma' }), '');
});

test('failed logins never invent a name', () => {
  assert.equal(say({ category: 'sign_in', action: 'login_failed', employee_id: null, actor_username: '(unknown)', actor_role: '' }), "Someone tried to log in with a username that doesn't exist");
  assert.equal(say({ category: 'sign_in', action: 'login_failed', employee_id: 'EMP-012', actor_username: 'EMP-012', actor_role: 'employee' }), 'Rahul Sharma failed to log in');
});

test('names are kept apart from the words around them so the page can bold them', () => {
  const parts = activitySentence({ category: 'admin', action: 'approve', target_type: 'leave_request', employee_id: 'EMP-012', actor_username: 'priya', actor_role: 'admin' }, lookups);
  assert.deepEqual(parts.filter(p => p.kind === 'name').map(p => p.text), ['Priya Mehta', 'Rahul Sharma']);
  assert.deepEqual(parts.filter(p => p.kind === 'role').map(p => p.text), [' (admin)']);
});

// --- what a failed login is allowed to record -------------------------------------
// server.js builds its database client at import time, so give it a throwaway URL.
// Requiring it starts no listener — that's behind `require.main === module`.
process.env.TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'file::memory:';
const { safeLoginUsername } = require('../server');

test('a failed login records the account only when the username matches one', () => {
  assert.equal(safeLoginUsername('EMP-001', { username: 'EMP-001' }), 'EMP-001');
  assert.equal(safeLoginUsername('admin', { username: 'admin' }), 'admin');
});

test('a failed login never records what was typed when no account matches', () => {
  // The case this exists for: a password in the username box. The log is permanent,
  // admin- and manager-readable and exported to CSV, so none of these may reach it.
  // Shape can't be the test — an API key and an employee id look alike — so anything
  // that doesn't match a real account is dropped, whatever it looks like.
  for (const typed of [
    'Hunter2!myRealPassword',
    'p@ssw0rd with spaces',
    'sk-live-0123456789abcdef',
    'correct-horse',
    'someone@theworkvilla.com',
    'EMP-999',
    '',
    null,
    undefined,
  ]) {
    assert.equal(safeLoginUsername(typed, undefined), '', JSON.stringify(typed));
  }
});

test('a recorded-but-empty change list keeps the summary instead of hiding it', () => {
  // A settings or branches save can write rows while every field compares equal (a
  // fresh database, where the value in force came from the default that was already
  // in the form). The entry must still say what it touched.
  const row = {
    category: 'admin', action: 'branches_updated', employee_id: '',
    actor_username: 'priya', actor_role: 'admin',
    details: 'LGF half Saturdays on, LGF shift 09:30-18:30', changes: '[]',
  };
  assert.deepEqual(parseChanges(row.changes), []);
  // [] is truthy, so the decision has to test its length. Both the page and the CSV
  // read it from here, so they cannot disagree about it again.
  assert.deepEqual(changesAndDetails(row), { changes: null, details: row.details });
  assert.equal(activityCsvRow(row, {})[2], row.details);
  // A non-empty list does replace the summary.
  const edited = { ...row, changes: '[{"field":"LGF shift","from":"09:30–18:30","to":"10:00–19:00"}]' };
  assert.equal(changesAndDetails(edited).details, '');
  assert.equal(activityCsvRow(edited, {})[2], 'LGF shift: 09:30–18:30 → 10:00–19:00');
});

test('a device PIN is never shown or exported, including from older entries', () => {
  const PIN = '4821';
  // What the route records now: that it changed, never the PIN itself.
  const changes = [{ field: 'Device PIN', hidden: true }];
  const json = JSON.stringify(changes);
  assert.ok(!json.includes(PIN));
  assert.equal(changesText(json), 'Device PIN: changed (value hidden)');
  // Entries written before it was hidden still hold the PIN in details.
  const old = {
    category: 'admin', action: 'set_device_pin', employee_id: 'EMP-003',
    actor_username: 'priya', actor_role: 'admin', details: PIN, changes: '',
  };
  assert.equal(detailsShown(old), '');
  assert.ok(!activityCsvRow(old, { employeeName: () => 'Rahul Sharma' }).some(c => String(c).includes(PIN)));
});
