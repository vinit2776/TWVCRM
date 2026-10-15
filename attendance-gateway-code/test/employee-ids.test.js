'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  formatEmployeeId, parseEmployeeNumber, employeeNumberOf, nextEmployeeNumber, renameEmployeeStatements,
} = require('../employee-ids');

test('formatEmployeeId pads to three digits without truncating', () => {
  assert.equal(formatEmployeeId(2), 'EMP-002');
  assert.equal(formatEmployeeId(53), 'EMP-053');
  assert.equal(formatEmployeeId(1234), 'EMP-1234');
});

test('parseEmployeeNumber accepts the ways an admin would type an Emp ID #', () => {
  for (const input of ['2', '002', ' 2 ', 'EMP-002', 'emp-2', 'EMP 2', 'emp2']) {
    assert.equal(parseEmployeeNumber(input), 2, input);
  }
  for (const input of ['', '0', '000', '-3', '2.5', 'abc', 'EMP-', 'TWV-2', '100000', null, undefined]) {
    assert.equal(parseEmployeeNumber(input), null, String(input));
  }
});

test('nextEmployeeNumber is one past the highest EMP number, ignoring gaps and odd ids', () => {
  assert.equal(nextEmployeeNumber([]), 1);
  assert.equal(nextEmployeeNumber([{ id: 'EMP-002' }, { id: 'EMP-053' }, { id: 'EMP-015' }, { id: 'EMP-TEST' }]), 54);
  assert.equal(employeeNumberOf('EMP-TEST'), null);
});

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE employees (id TEXT PRIMARY KEY, name TEXT NOT NULL, reports_to TEXT, device_pin TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL, employee_id TEXT);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, employee_id TEXT);
    CREATE TABLE punches (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, marked_by TEXT DEFAULT '');
    CREATE TABLE breaks (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL);
    CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL);
    CREATE TABLE leave_balances (employee_id TEXT NOT NULL, leave_type TEXT NOT NULL, balance REAL, PRIMARY KEY (employee_id, leave_type));
    CREATE TABLE leave_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL);
    CREATE TABLE permission_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL);
    CREATE TABLE correction_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, decided_by TEXT);
    CREATE TABLE overtime_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL);
    CREATE TABLE field_trips (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL);
    CREATE TABLE employee_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id TEXT NOT NULL, uploaded_by TEXT);
    CREATE TABLE device_commands (id INTEGER PRIMARY KEY AUTOINCREMENT, requested_by TEXT);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, updated_by TEXT NOT NULL DEFAULT '');
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'other', action TEXT NOT NULL DEFAULT 'login', employee_id TEXT, actor_username TEXT NOT NULL DEFAULT '');
    CREATE TABLE deviation_reviews (employee_id TEXT NOT NULL, date TEXT NOT NULL, decision TEXT NOT NULL, reviewed_by TEXT NOT NULL, PRIMARY KEY (employee_id, date));
  `);
  return db;
}

// Mirrors the server's atomic batch: all statements commit together or none do.
function runBatch(db, statements) {
  db.exec('BEGIN');
  try {
    for (const { sql, args } of statements) db.prepare(sql).run(...args);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Columns holding an actor's username rather than the subject's employee id.
const ACTOR_COLUMNS = [
  ['punches', 'marked_by'],
  ['correction_requests', 'decided_by'],
  ['device_commands', 'requested_by'],
  ['app_settings', 'updated_by'],
  ['deviation_reviews', 'reviewed_by'],
  ['employee_documents', 'uploaded_by'],
];

const EMPLOYEE_TABLES = [
  'punches', 'breaks', 'notifications', 'leave_requests', 'permission_requests',
  'correction_requests', 'overtime_requests', 'field_trips', 'employee_documents', 'activity_log',
];

test('renaming moves every record and the login to the new id, leaving nothing behind', () => {
  const db = setup();
  db.exec(`
    INSERT INTO employees VALUES ('EMP-001', 'Noorul Hutha J', NULL, '7'), ('EMP-002', 'Vignesh V', 'EMP-001', NULL);
    INSERT INTO users (username, role, employee_id) VALUES ('EMP-001', 'manager', 'EMP-001'), ('EMP-002', 'employee', 'EMP-002');
    INSERT INTO sessions VALUES ('t1', 'EMP-001', 'EMP-001');
    INSERT INTO leave_balances VALUES ('EMP-001', 'casual', 6), ('EMP-001', 'sick', 6);
    INSERT INTO punches (employee_id, marked_by) VALUES ('EMP-001', ''), ('EMP-002', 'EMP-001');
    INSERT INTO correction_requests (employee_id, decided_by) VALUES ('EMP-002', 'EMP-001');
    INSERT INTO device_commands (requested_by) VALUES ('EMP-001');
    INSERT INTO app_settings VALUES ('office_radius', 'EMP-001');
    INSERT INTO employee_documents (employee_id, uploaded_by) VALUES ('EMP-002', 'EMP-001');
    INSERT INTO deviation_reviews VALUES ('EMP-001', '2026-10-14', 'absent', 'EMP-001');
  `);
  for (const table of EMPLOYEE_TABLES) db.prepare(`INSERT INTO ${table} (employee_id) VALUES ('EMP-001')`).run();

  runBatch(db, renameEmployeeStatements('EMP-001', 'EMP-027'));

  const employee = db.prepare("SELECT * FROM employees WHERE id = 'EMP-027'").get();
  assert.equal(employee.name, 'Noorul Hutha J');
  assert.equal(employee.device_pin, '7');
  assert.equal(db.prepare("SELECT reports_to FROM employees WHERE id = 'EMP-002'").get().reports_to, 'EMP-027');
  const login = db.prepare("SELECT * FROM users WHERE employee_id = 'EMP-027'").get();
  assert.equal(login.username, 'EMP-027');
  assert.equal(login.role, 'manager');
  assert.deepEqual({ ...db.prepare("SELECT username, employee_id FROM sessions WHERE token = 't1'").get() }, { username: 'EMP-027', employee_id: 'EMP-027' });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM leave_balances WHERE employee_id = 'EMP-027'").get().c, 2);
  assert.equal(db.prepare("SELECT marked_by FROM punches WHERE employee_id = 'EMP-002'").get().marked_by, 'EMP-027');
  assert.equal(db.prepare('SELECT decided_by FROM correction_requests WHERE employee_id = ?').get('EMP-002').decided_by, 'EMP-027');
  assert.equal(db.prepare('SELECT requested_by FROM device_commands').get().requested_by, 'EMP-027');
  assert.equal(db.prepare('SELECT updated_by FROM app_settings').get().updated_by, 'EMP-027');
  assert.equal(db.prepare('SELECT uploaded_by FROM employee_documents WHERE employee_id = ?').get('EMP-002').uploaded_by, 'EMP-027');
  // A manager's decision on a deviation day must follow the employee: left behind, the
  // day silently loses its Absent/Half Day status and returns to the pending queue.
  assert.equal(db.prepare("SELECT decision FROM deviation_reviews WHERE employee_id = 'EMP-027'").get().decision, 'absent');

  // An activity entry follows the employee it's about, but who did it stays as it was.
  db.prepare("INSERT INTO activity_log (employee_id, actor_username) VALUES ('EMP-027', 'EMP-001')").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE employee_id = 'EMP-027'").get().c, 2);

  // Nothing anywhere still points at the old id.
  for (const table of [...EMPLOYEE_TABLES, 'leave_balances', 'users', 'sessions', 'deviation_reviews']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE employee_id = 'EMP-001'`).get().c, 0, table);
  }
  // The "done by" columns hold the actor's username, which for a manager is their
  // employee id. Sweeping these as well as employee_id is what would have caught
  // employee_documents.uploaded_by being missed.
  for (const [table, column] of ACTOR_COLUMNS) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = 'EMP-001'`).get().c, 0, `${table}.${column}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM employees WHERE id = 'EMP-001' OR reports_to = 'EMP-001'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'EMP-001'").get().c, 0);
  // The other employee is untouched.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'EMP-002'").get().c, 1);
});

test('a rename onto an id that is already taken changes nothing', () => {
  const db = setup();
  db.exec(`
    INSERT INTO employees VALUES ('EMP-001', 'Aruna P.V', NULL, NULL), ('EMP-002', 'Karan A', NULL, NULL);
    INSERT INTO users (username, role, employee_id) VALUES ('EMP-001', 'employee', 'EMP-001'), ('EMP-002', 'employee', 'EMP-002');
    INSERT INTO punches (employee_id) VALUES ('EMP-001');
  `);
  assert.throws(() => runBatch(db, renameEmployeeStatements('EMP-001', 'EMP-002')), /UNIQUE/);
  assert.equal(db.prepare("SELECT name FROM employees WHERE id = 'EMP-001'").get().name, 'Aruna P.V');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM punches WHERE employee_id = 'EMP-001'").get().c, 1);
});
