// Rules shared by every "employee applies, manager decides" flow (leave, permission,
// corrections, overtime, field trips): the employee's reason and the manager's note
// are both required, and a rejected request can be filed again with a new reason.
// Each new attempt points at the one it replaces (previous_request_id), so the whole
// back-and-forth stays readable as one thread, however many rounds it takes.

const NOTE_MIN_LENGTH = 3;
const NOTE_MAX_LENGTH = 500;

// Tables that take part, and the column holding the employee's reason. Used to build
// the shared SQL below, so only names from this list ever reach a query string.
const REQUEST_TABLES = ['leave_requests', 'permission_requests', 'correction_requests', 'overtime_requests', 'field_trips'];

// Returns { value } with the trimmed text, or { error } with an i18n key.
function cleanNote(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (value.length < NOTE_MIN_LENGTH) return { error: 'notes.err_required' };
  if (value.length > NOTE_MAX_LENGTH) return { error: 'notes.err_too_long' };
  return { value };
}

function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
}

// The earlier attempts behind a request, oldest first. getById looks a request up in
// the same table (sync or async). Stops at a missing link or a loop, so a bad row can
// never hang a page.
async function earlierAttempts(request, getById) {
  const chain = [];
  const seen = new Set([request.id]);
  let previousId = request.previous_request_id;
  while (previousId != null && !seen.has(previousId) && chain.length < 50) {
    seen.add(previousId);
    const previous = await getById(previousId);
    if (!previous) break;
    chain.unshift(previous);
    previousId = previous.previous_request_id;
  }
  return chain;
}

// Whether `previous` may be filed again by this employee. reappliedAlready is true when
// another request already points at it — one rejection gets one follow-up, so the
// thread never forks into two parallel attempts. Returns null or an i18n key.
function reapplyError(previous, employeeId, reappliedAlready) {
  if (!previous || previous.employee_id !== employeeId) return 'notes.err_reapply_unknown';
  if (previous.status !== 'rejected') return 'notes.err_reapply_not_rejected';
  if (reappliedAlready) return 'notes.err_reapply_done';
  return null;
}

// Appended to the employee's in-app notification so they see why without opening the page.
function decisionNoteSuffix(note, decidedBy) {
  if (!note) return '';
  return ` ${decidedBy ? `${decidedBy}'s note` : 'Note'}: "${note}"`;
}

module.exports = {
  NOTE_MIN_LENGTH, NOTE_MAX_LENGTH, REQUEST_TABLES,
  cleanNote, ordinal, earlierAttempts, reapplyError, decisionNoteSuffix,
};
