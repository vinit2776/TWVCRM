'use strict';

// Employee IDs carry the company's own Emp ID # from HR records (EMP-002 for #2),
// so the app, payroll and the biometric device all talk about the same number. The
// number is chosen by the admin, not handed out sequentially — gaps are expected
// (people who have left keep their number retired).

const EMPLOYEE_ID_PREFIX = 'EMP-';
const MAX_EMPLOYEE_NUMBER = 99999;

// padStart(3) only pads — #1234 becomes EMP-1234, not a truncated EMP-234.
function formatEmployeeId(n) {
  return `${EMPLOYEE_ID_PREFIX}${String(n).padStart(3, '0')}`;
}

// Accepts what an admin would naturally type: "2", "002", "EMP-002", "emp 2".
// Returns the positive integer, or null for anything else.
function parseEmployeeNumber(input) {
  const m = String(input == null ? '' : input).trim().match(/^(?:emp[-\s]?)?0*(\d+)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 && n <= MAX_EMPLOYEE_NUMBER ? n : null;
}

// The number inside an existing EMP-NNN id, or null for ids that aren't in that
// shape (e.g. a hand-made test account).
function employeeNumberOf(id) {
  const m = String(id).match(/^EMP-0*(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function nextEmployeeNumber(employees) {
  return employees.reduce((max, e) => {
    const n = employeeNumberOf(e.id);
    return n !== null && n > max ? n : max;
  }, 0) + 1;
}

// Every place an employee id (or the matching login username, which is the same
// string) is stored. Run together as one atomic batch so a failure part-way can never
// leave someone's punches under one id and their leave under another.
// admin_audit_log and login_attempts are deliberately left alone: they are a record of
// what happened under the old id, and the rename itself is logged against both ids.
function renameEmployeeStatements(oldId, newId) {
  const s = (sql) => ({ sql, args: [newId, oldId] });
  return [
    s('UPDATE employees SET id = ? WHERE id = ?'),
    s('UPDATE employees SET reports_to = ? WHERE reports_to = ?'),
    s('UPDATE users SET employee_id = ? WHERE employee_id = ?'),
    s('UPDATE users SET username = ? WHERE username = ?'),
    // Keeps the person signed in rather than bouncing them to a login page that now
    // expects a username they haven't been told yet.
    s('UPDATE sessions SET employee_id = ? WHERE employee_id = ?'),
    s('UPDATE sessions SET username = ? WHERE username = ?'),
    s('UPDATE punches SET employee_id = ? WHERE employee_id = ?'),
    s('UPDATE breaks SET employee_id = ? WHERE employee_id = ?'),
    s('UPDATE notifications SET employee_id = ? WHERE employee_id = ?'),
    s('UPDATE leave_balances SET employee_id = ? WHERE employee_id = ?'),
    s('UPDATE leave_requests SET employee_id = ? WHERE employee_id = ?'),
    s('UPDATE permission_requests SET employee_id = ? WHERE employee_id = ?'),
    s('UPDATE correction_requests SET employee_id = ? WHERE employee_id = ?'),
    s('UPDATE overtime_requests SET employee_id = ? WHERE employee_id = ?'),
    s('UPDATE field_trips SET employee_id = ? WHERE employee_id = ?'),
    s('UPDATE employee_documents SET employee_id = ? WHERE employee_id = ?'),
    // "Done by" columns hold the actor's username — a manager's is their employee id.
    s('UPDATE punches SET marked_by = ? WHERE marked_by = ?'),
    s('UPDATE correction_requests SET decided_by = ? WHERE decided_by = ?'),
    s('UPDATE device_commands SET requested_by = ? WHERE requested_by = ?'),
    s('UPDATE app_settings SET updated_by = ? WHERE updated_by = ?'),
  ];
}

module.exports = {
  EMPLOYEE_ID_PREFIX,
  MAX_EMPLOYEE_NUMBER,
  formatEmployeeId,
  parseEmployeeNumber,
  employeeNumberOf,
  nextEmployeeNumber,
  renameEmployeeStatements,
};
