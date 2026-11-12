'use strict';

// One timeline of everything people do in the app — sign-ins, punches, breaks,
// requests and every admin/manager action — for admins and managers to review at
// /admin/activity-log. Pure helpers only (labels, filters, CSV shape), kept out of
// server.js so they can be unit-tested without a database or a request.

const ACTIVITY_CATEGORIES = [
  { key: 'sign_in', label: 'Logins and logouts' },
  { key: 'attendance', label: 'Punches and breaks' },
  { key: 'request', label: 'Requests' },
  { key: 'admin', label: 'Admin and manager actions' },
  { key: 'other', label: 'Other' },
];

// Events logged by name from the routes that cause them. Admin actions aren't listed
// here: they come through logAdminAction with their own action/target_type pairs and
// are labelled by adminActionLabel() below.
const ACTIONS = {
  login: { category: 'sign_in', label: 'Login' },
  login_failed: { category: 'sign_in', label: 'Login failed' },
  login_blocked: { category: 'sign_in', label: 'Login blocked (too many attempts)' },
  logout: { category: 'sign_in', label: 'Logout' },
  password_changed: { category: 'sign_in', label: 'Changed password' },
  punch_in: { category: 'attendance', label: 'Punch in' },
  punch_out: { category: 'attendance', label: 'Punch out' },
  break_start: { category: 'attendance', label: 'Break started' },
  break_end: { category: 'attendance', label: 'Break ended' },
  field_trip: { category: 'attendance', label: 'Recorded field trip' },
  leave_applied: { category: 'request', label: 'Applied for leave' },
  permission_applied: { category: 'request', label: 'Applied for permission' },
  correction_applied: { category: 'request', label: 'Asked for a correction' },
  overtime_applied: { category: 'request', label: 'Applied for overtime' },
  document_uploaded: { category: 'other', label: 'Uploaded document' },
  language_changed: { category: 'other', label: 'Changed language' },
};

const TARGET_LABELS = {
  leave_request: 'leave',
  permission_request: 'permission',
  correction_request: 'correction',
  overtime_request: 'overtime',
  field_trip: 'field trip',
  hours_worked_report: 'Hours Worked report',
  punch_in_report: 'Punch-in report',
  punch_in_detail_report: 'Punch-in detail report',
  leave_report: 'Leave report',
  muster_report: 'Muster report',
  activity_log: 'Activity Log CSV',
};

const ADMIN_ACTION_LABELS = {
  add_employee: 'Registered employee',
  edit_employee: 'Edited employee',
  change_employee_id: 'Changed Emp ID #',
  change_account_role: 'Changed account role',
  reset_password: 'Reset password',
  upload_document: 'Uploaded document',
  set_device_pin: 'Set device PIN',
  add_holiday: 'Added holiday',
  delete_holiday: 'Deleted holiday',
  device_resync: 'Re-synced biometric device',
  settings_updated: 'Changed settings',
  branches_updated: 'Changed branches',
  punches_rechecked: 'Re-checked punch locations',
  punch_api_key_generated: 'Generated punch API key',
  deviation_undo: 'Undid deviation review',
};

function adminActionLabel(action, targetType) {
  if (action === 'approve' || action === 'reject') {
    return `${action === 'approve' ? 'Approved' : 'Rejected'} ${TARGET_LABELS[targetType] || targetType}`;
  }
  if (action === 'record' && targetType === 'overtime_request') return 'Recorded overtime';
  if (action === 'download_report') return `Downloaded ${TARGET_LABELS[targetType] || targetType}`;
  if (ADMIN_ACTION_LABELS[action]) return ADMIN_ACTION_LABELS[action];
  if (action.startsWith('deviation_')) return 'Reviewed deviation';
  const words = action.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// What the log shows in its "What" column for a stored row.
function activityLabel(row) {
  if (row.category === 'admin') return adminActionLabel(row.action, row.target_type || '');
  return (ACTIONS[row.action] && ACTIONS[row.action].label) || row.action;
}

function categoryOf(action) {
  return (ACTIONS[action] && ACTIONS[action].category) || 'other';
}

// "Android phone · Chrome" from a User-Agent header. Coarse on purpose: enough to tell
// someone's phone from a shared office computer, without fingerprinting anyone.
function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return '';
  let os = '';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  else if (/Windows/.test(ua)) os = 'Windows computer';
  else if (/Macintosh|Mac OS X/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux computer';
  let browser = '';
  if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Firefox|FxiOS/.test(ua)) browser = 'Firefox';
  else if (/Chrome|CriOS/.test(ua)) browser = 'Chrome';
  else if (/Safari/.test(ua)) browser = 'Safari';
  const parts = [os, browser].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Other device';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// WHERE clause for the page and the CSV download. Dates are inclusive calendar days
// against created_at ("YYYY-MM-DD HH:MM:SS"); anything malformed is ignored rather than
// turned into a query error.
function activityFilterSql({ employeeId, category, from, to } = {}) {
  const where = [];
  const args = [];
  if (employeeId) { where.push('employee_id = ?'); args.push(employeeId); }
  if (category && ACTIVITY_CATEGORIES.some(c => c.key === category)) { where.push('category = ?'); args.push(category); }
  if (from && DATE_RE.test(from)) { where.push('created_at >= ?'); args.push(`${from} 00:00:00`); }
  if (to && DATE_RE.test(to)) { where.push('created_at <= ?'); args.push(`${to} 23:59:59`); }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

const ACTIVITY_CSV_HEADERS = ['Time', 'Employee ID', 'Employee', 'Done by', 'Role', 'Category', 'Activity', 'Details', 'Device', 'IP address'];

function activityCsvRow(row, employeeName) {
  const category = ACTIVITY_CATEGORIES.find(c => c.key === row.category);
  return [
    row.created_at,
    row.employee_id || '',
    employeeName || '',
    row.actor_username || '',
    row.actor_role || '',
    category ? category.label : row.category,
    activityLabel(row),
    row.details || '',
    describeDevice(row.user_agent),
    row.ip || '',
  ];
}

module.exports = {
  ACTIVITY_CATEGORIES,
  ACTIONS,
  activityLabel,
  categoryOf,
  describeDevice,
  activityFilterSql,
  ACTIVITY_CSV_HEADERS,
  activityCsvRow,
};
