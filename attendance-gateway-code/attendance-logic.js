'use strict';

const { employeeBranches } = require('./geofence');

// Extracted from server.js so computeDayStatus() can be unit-tested against an
// isolated database instead of the app's real attendance.db (see
// docs/designs/security-hardening.md, item 7 / outside-voice finding #17).
// Pure refactor: same logic, same behavior — createAttendanceLogic(db) just
// makes the db handle a parameter instead of a module-level singleton.

const LAUNCH_DATE = '2026-07-29';
const GRACE_LATE_MINUTES = 15;
const GRACE_EARLY_MINUTES = 5;
const HALF_DAY_SATURDAYS = [2, 4];
const SATURDAY_HALF_SHIFT = { start: '09:30', end: '13:30' };
// Missed check-in/check-out corrections an employee can file per month (pending +
// approved count; rejected don't). Past the limit a correction still fixes the times,
// but the day counts as a Half Day. A full-day correction (forgot both) is a separate
// allowance; once it's used, a day with no punches at all stays Absent.
const CORRECTION_MONTHLY_LIMIT = 2;
const FULL_DAY_CORRECTION_MONTHLY_LIMIT = 1;

function pad(n) { return String(n).padStart(2, '0'); }
function todayStr(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function parseTimeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function timeOfDayMinutes(timestamp) {
  const [h, m] = timestamp.split(' ')[1].split(':').map(Number);
  return h * 60 + m;
}
function isSunday(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay() === 0;
}
function isSaturday(dateStr) {
  return new Date(`${dateStr}T00:00:00`).getDay() === 6;
}
function saturdayOccurrenceInMonth(dateStr) {
  return Math.ceil(Number(dateStr.split('-')[2]) / 7);
}

// A synthetic auto-checkout (source 'auto') only ever fills a gap — it never outranks
// a real punch. The biometric device buffers punches and re-sends them when the office
// relay or internet is down, so a real check-out stamped 18:30 can land *after* the 19:00
// auto-checkout already closed the day. Counting both left three punches (odd), and the
// day showed Punch Error. So: if the real punches pair up on their own, use them and
// ignore the auto-checkout; only if they leave a check-in open does the auto-checkout
// close it — and only when it comes after the last real punch, or it would pair with
// the wrong one.
// Approved corrections (source 'correction') count as real punches, except when the
// device's own punches already pair up — that same buffering can deliver the real
// check-out after a correction for it was approved, and the device wins.
function effectivePunches(dayPunches) {
  const real = dayPunches.filter(p => p.source !== 'auto');
  const device = real.filter(p => p.source !== 'correction');
  if (device.length > 0 && device.length % 2 === 0) return device;
  if (real.length % 2 === 0) return real;
  const autos = dayPunches.filter(p => p.source === 'auto');
  const auto = autos[autos.length - 1];
  if (auto && auto.timestamp > real[real.length - 1].timestamp) return [...real, auto];
  return real;
}

// --- Which shift applies on a day ---
// Branches carry their own weekday shift and, if they have half Saturdays (2nd and 4th),
// a half-Saturday shift; an employee either
// follows the branch (shift_custom 0) or has their own weekday timings (shift_custom 1).
// The branch is the one they first punched in at that day (GPS or the biometric device),
// so someone at LGF and Perungudi works whichever branch's hours they turned up at;
// a remote first punch, or no punch yet, falls back to their own branch.
const DEFAULT_SHIFT = { start: '09:30', end: '18:30' };
const AUTO_CHECKOUT_AFTER_SHIFT_MINUTES = 15;

function isHalfSaturday(dateStr) {
  return isSaturday(dateStr) && HALF_DAY_SATURDAYS.includes(saturdayOccurrenceInMonth(dateStr));
}

function validTime(v) {
  return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : '';
}

// The branch a day counts as worked at: the branch of the first real punch, else the
// employee's own branch (the first, for someone at a few), else none.
function dayBranchName(employee, dayPunches = []) {
  const first = (dayPunches || []).find(p => p.source !== 'auto');
  if (first && first.branch) return first.branch;
  const { all, names } = employeeBranches(employee && employee.branch);
  return !all && names.length ? names[0] : null;
}

// Pure. branches: [{ name, shift_start, shift_end, half_saturdays, sat_start, sat_end }] ('' = not set).
// Returns { start, end, source: 'branch' | 'custom' | 'employee' | 'default', branch }.
function resolveShift(employee, dateStr, dayPunches = [], branches = []) {
  const branchName = dayBranchName(employee, dayPunches);
  const branch = branchName ? (branches || []).find(b => b.name === branchName) || null : null;
  // Half Saturdays are a per-branch choice (LGF has them; other branches work every
  // Saturday in full). Someone with no branch keeps the old company-wide rule.
  if (isHalfSaturday(dateStr) && (!branch || Number(branch.half_saturdays))) {
    const start = validTime(branch && branch.sat_start);
    const end = validTime(branch && branch.sat_end);
    if (start && end) return { start, end, source: 'branch', branch: branchName };
    return { ...SATURDAY_HALF_SHIFT, source: 'default', branch: branchName };
  }
  const own = { start: validTime(employee && employee.shift_start), end: validTime(employee && employee.shift_end) };
  if (employee && Number(employee.shift_custom) && own.start && own.end) {
    return { ...own, source: 'custom', branch: branchName };
  }
  const start = validTime(branch && branch.shift_start);
  const end = validTime(branch && branch.shift_end);
  if (start && end) return { start, end, source: 'branch', branch: branchName };
  // A branch with no timings yet (or no branch): what's saved on the employee.
  if (own.start && own.end) return { ...own, source: 'employee', branch: branchName };
  return { ...DEFAULT_SHIFT, source: 'default', branch: branchName };
}

// When a still-open day gets its auto punch-out: AUTO_CHECKOUT_AFTER_SHIFT_MINUTES after
// that day's shift end, as "YYYY-MM-DD HH:MM:SS". Capped at 23:59 so it stays that day.
function autoCheckoutTimestamp(dateStr, shift) {
  const minutes = Math.min(parseTimeToMinutes(shift.end) + AUTO_CHECKOUT_AFTER_SHIFT_MINUTES, 23 * 60 + 59);
  return `${dateStr} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
}

// Pure. The auto punch-out an open day is due, as a timestamp, or null when it needs
// none yet: the day already pairs up, already had one, isn't due until later than `now`
// ("YYYY-MM-DD HH:MM:SS"), or was punched into after the due time (a checkout stamped
// before the check-in can't close it). A real punch-out made after it still replaces
// it — see effectivePunches.
function autoCheckoutDue(employee, dateStr, dayPunches, branches, now) {
  const punches = dayPunches || [];
  if (!punches.length) return null;
  if (effectivePunches(punches).length % 2 === 0) return null;
  if (punches.some(p => p.source === 'auto')) return null;
  const dueTs = autoCheckoutTimestamp(dateStr, resolveShift(employee, dateStr, punches, branches));
  if (dueTs > now) return null;
  if (punches[punches.length - 1].timestamp >= dueTs) return null;
  return dueTs;
}

// When a day ended for someone, for closing anything still left running at that point —
// today that means a break they never resumed. The day's real punch-out if it has one,
// else the time its auto punch-out is due; null while the day hasn't got there yet, so a
// break still inside the shift is left alone. Pass the punches as they were read: an auto
// punch-out recorded from them in the meantime leaves the count odd, and the due time is
// the same answer anyway.
function dayEndTimestamp(employee, dateStr, dayPunches, branches, now) {
  const dueTs = autoCheckoutTimestamp(dateStr, resolveShift(employee, dateStr, dayPunches, branches));
  if (dueTs > now) return null;
  const punches = effectivePunches(dayPunches || []);
  return punches.length > 0 && punches.length % 2 === 0 ? punches[punches.length - 1].timestamp : dueTs;
}

// Picks the timings a branch's employees mostly work, for seeding a branch's shift the
// first time: [{ shift_start, shift_end }] -> { start, end } or null.
function mostCommonShift(employees) {
  const counts = new Map();
  for (const e of employees || []) {
    const start = validTime(e.shift_start);
    const end = validTime(e.shift_end);
    if (!start || !end) continue;
    const key = `${start}-${end}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) { best = key; bestCount = count; }
  }
  if (!best) return null;
  const [start, end] = best.split('-');
  return { start, end };
}

// getBranches: () => the branch list (server.js passes its cached copy). Without it,
// branches are read from the db on each call, which only the unit tests rely on.
function createAttendanceLogic(db, { getBranches = null } = {}) {
  function branchList() {
    if (getBranches) return getBranches() || [];
    try {
      const rows = db.prepare('SELECT * FROM branches').all();
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }
  function getEmployee(id) {
    return db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  }
  function getPunchesForDay(employeeId, dateStr) {
    return db.prepare('SELECT * FROM punches WHERE employee_id = ? AND timestamp LIKE ? ORDER BY timestamp ASC')
      .all(employeeId, `${dateStr}%`);
  }
  function getBreaksForDay(employeeId, dateStr) {
    return db.prepare('SELECT * FROM breaks WHERE employee_id = ? AND start_ts LIKE ? ORDER BY start_ts ASC')
      .all(employeeId, `${dateStr}%`);
  }
  // Saturdays are working days; the 2nd and 4th Saturday of the month run a shorter shift
  // rather than being a day off. See resolveShift for how branch, custom and Saturday
  // timings combine. Pass the day's punches when known, so a day worked at another
  // branch gets that branch's hours.
  function getShiftForDate(employee, dateStr, dayPunches = []) {
    return resolveShift(employee, dateStr, dayPunches, branchList());
  }
  function getHoliday(dateStr) {
    return db.prepare('SELECT * FROM holidays WHERE date = ?').get(dateStr);
  }
  // A manager's decision on a day the employee punched at a branch that isn't theirs:
  // 'accepted', or rejected as 'absent' / 'half_day'. None means still pending.
  function getDeviationReview(employeeId, dateStr) {
    return db.prepare('SELECT * FROM deviation_reviews WHERE employee_id = ? AND date = ?').get(employeeId, dateStr);
  }
  function getApprovedLeaveForDate(employeeId, dateStr) {
    return db.prepare(
      `SELECT * FROM leave_requests WHERE employee_id = ? AND status = 'approved' AND date(?) BETWEEN date(start_date) AND date(end_date)`
    ).get(employeeId, dateStr);
  }
  function getApprovedPermissionForDate(employeeId, dateStr) {
    return db.prepare(
      "SELECT * FROM permission_requests WHERE employee_id = ? AND date = ? AND status = 'approved'"
    ).get(employeeId, dateStr);
  }

  // Pending + approved corrections for the employee's whole month, oldest first — the
  // order is what decides which ones fall past CORRECTION_MONTHLY_LIMIT.
  function getActiveCorrectionsForMonth(employeeId, monthPrefix) {
    return db.prepare(
      "SELECT * FROM correction_requests WHERE employee_id = ? AND date LIKE ? AND status IN ('pending', 'approved') ORDER BY id ASC"
    ).all(employeeId, `${monthPrefix}%`);
  }

  // Async because the db handle may be the libSQL/Turso client (network-backed,
  // Promise-returning). `await` also works transparently over the synchronous
  // node:sqlite handle the unit tests use, so both paths share this one code path.
  async function computeDayStatus(employeeId, dateStr) {
    const employee = await getEmployee(employeeId);
    if (!employee) return null;
    const dayPunches = await getPunchesForDay(employeeId, dateStr);
    const punches = effectivePunches(dayPunches);

    if (punches.length === 0) {
      // An employee's own join date is authoritative for "no attendance obligation
      // yet" — checked before anything else, same treatment as the pre-LAUNCH_DATE
      // fallback below: no punches before someone was even hired isn't Absent. Without
      // this, every employee joining after LAUNCH_DATE showed a string of false
      // Absent days stretching back to LAUNCH_DATE the moment they were registered.
      if (employee.date_joined && dateStr < employee.date_joined) {
        return { date: dateStr, status: 'Present', checkIn: null, checkOut: null, hoursWorked: 0, breakMinutes: 0, onBreak: false, breakStart: null };
      }
      // Schedule facts (holiday / week off / approved leave) apply whether the date is
      // in the past or future — only fall back to Upcoming/Absent once those are ruled out.
      const holiday = await getHoliday(dateStr);
      if (holiday) {
        return { date: dateStr, status: 'Holiday', checkIn: null, checkOut: null, hoursWorked: 0, breakMinutes: 0, onBreak: false, breakStart: null, label: holiday.name };
      }
      if (isSunday(dateStr)) {
        return { date: dateStr, status: 'Week Off', checkIn: null, checkOut: null, hoursWorked: 0, breakMinutes: 0, onBreak: false, breakStart: null };
      }
      const leave = await getApprovedLeaveForDate(employeeId, dateStr);
      if (leave) {
        return { date: dateStr, status: 'On Leave', checkIn: null, checkOut: null, hoursWorked: 0, breakMinutes: 0, onBreak: false, breakStart: null, label: leave.leave_type };
      }
      if (dateStr < LAUNCH_DATE) {
        return { date: dateStr, status: 'Present', checkIn: null, checkOut: null, hoursWorked: 0, breakMinutes: 0, onBreak: false, breakStart: null };
      }
      if (dateStr > todayStr()) {
        return { date: dateStr, status: 'Upcoming', checkIn: null, checkOut: null, hoursWorked: 0, breakMinutes: 0, onBreak: false, breakStart: null };
      }
      return { date: dateStr, status: 'Absent', checkIn: null, checkOut: null, hoursWorked: 0, breakMinutes: 0, onBreak: false, breakStart: null };
    }

    const checkIn = punches[0];
    const checkOut = punches.length % 2 === 0 ? punches[punches.length - 1] : null;

    const shift = getShiftForDate(employee, dateStr, dayPunches);
    const shiftStartMin = parseTimeToMinutes(shift.start);
    const shiftEndMin = parseTimeToMinutes(shift.end);
    const isLate = timeOfDayMinutes(checkIn.timestamp) > shiftStartMin + GRACE_LATE_MINUTES;

    const permission = await getApprovedPermissionForDate(employeeId, dateStr);

    // Breaks pause work time without affecting the punch in/out pair above — a break
    // is tracked in its own table rather than as a punch, so it can't be mistaken for
    // a check-out by the odd/even punch-count logic that drives Active/Punch Error.
    const breaks = await getBreaksForDay(employeeId, dateStr);
    const openBreak = breaks.find(b => !b.end_ts) || null;
    const breakMinutes = Math.round(breaks.reduce((sum, b) => {
      if (!b.end_ts) return sum;
      const s = new Date(b.start_ts.replace(' ', 'T')).getTime();
      const e = new Date(b.end_ts.replace(' ', 'T')).getTime();
      return sum + (e - s) / 60000;
    }, 0));

    const monthCorrections = await getActiveCorrectionsForMonth(employeeId, dateStr.slice(0, 7));
    // Only a correction whose punch is actually in use counts — see effectivePunches.
    const correction = punches.some(p => p.source === 'correction')
      ? monthCorrections.find(c => c.date === dateStr && c.status === 'approved') || null
      : null;
    // Only the 19:00 auto-checkout closed the day: the employee forgot to check out.
    const missedCheckout = !!checkOut && checkOut.source === 'auto';

    let isHalfDay = false;
    let hoursWorked = 0;
    if (missedCheckout) {
      // Counted up to the shift end (or the auto-checkout, if earlier) rather than 19:00,
      // so forgetting to check out never earns more hours than leaving on time.
      isHalfDay = true;
      const inMs = new Date(checkIn.timestamp.replace(' ', 'T')).getTime();
      const shiftEndMs = new Date(`${dateStr}T${shift.end}:00`).getTime();
      const autoMs = new Date(checkOut.timestamp.replace(' ', 'T')).getTime();
      const netMinutes = Math.max(0, (Math.min(shiftEndMs, autoMs) - inMs) / 60000 - breakMinutes);
      hoursWorked = Math.round((netMinutes / 60) * 100) / 100;
    } else if (checkOut) {
      const checkOutMin = timeOfDayMinutes(checkOut.timestamp);
      isHalfDay = checkOutMin < shiftEndMin - GRACE_EARLY_MINUTES;
      // An approved permission to leave early excuses the Half Day flag, as long as they
      // didn't leave even earlier than what was actually approved.
      if (isHalfDay && permission && checkOutMin >= parseTimeToMinutes(permission.leave_time)) {
        isHalfDay = false;
      }
      const inMs = new Date(checkIn.timestamp.replace(' ', 'T')).getTime();
      const outMs = new Date(checkOut.timestamp.replace(' ', 'T')).getTime();
      const netMinutes = Math.max(0, (outMs - inMs) / 60000 - breakMinutes);
      hoursWorked = Math.round((netMinutes / 60) * 100) / 100;
    }
    if (correction && correction.kind !== 'both' && correctionOverLimit(monthCorrections, correction)) {
      isHalfDay = true;
    }

    // Punched at a branch that isn't theirs (see deviation in server.js). Until a manager
    // decides, the day keeps its normal status and is only flagged; a rejection replaces
    // the status with the outcome the manager chose.
    const deviationReview = dayPunches.some(p => p.deviation) ? await getDeviationReview(employeeId, dateStr) : null;
    const deviation = dayPunches.some(p => p.deviation) ? (deviationReview ? deviationReview.decision : 'pending') : null;
    if (deviation === 'half_day') isHalfDay = true;

    let status;
    if (deviation === 'absent') {
      status = 'Absent';
      hoursWorked = 0;
    } else if (punches.length % 2 !== 0) {
      status = dateStr === todayStr() ? 'Active' : 'Punch Error';
    } else if (deviation === 'half_day') {
      status = 'Half Day';
    } else if (missedCheckout) {
      status = 'Missed Checkout';
    } else if (isHalfDay) {
      status = 'Half Day';
    } else if (isLate) {
      status = 'Late';
    } else {
      status = 'Present';
    }

    return {
      date: dateStr,
      status,
      checkIn: checkIn.timestamp,
      checkOut: checkOut ? checkOut.timestamp : null,
      checkOutAuto: checkOut ? checkOut.source === 'auto' : false,
      // The full punch rows, for where each was made (office vs. a remote location).
      checkInPunch: checkIn,
      checkOutPunch: checkOut,
      hoursWorked,
      late: isLate,
      halfDay: isHalfDay,
      permission: permission ? permission.leave_time : null,
      // Corrected check-outs still count as a missed check-out for the monthly tally.
      missedCheckout: missedCheckout || (!!correction && correction.kind === 'check_out'),
      correctionKind: correction ? correction.kind : null,
      breakMinutes,
      onBreak: !!openBreak,
      breakStart: openBreak ? openBreak.start_ts : null,
      // null, or 'pending' / 'accepted' / 'absent' / 'half_day'.
      deviation,
    };
  }

  return {
    getEmployee,
    getPunchesForDay,
    getBreaksForDay,
    getShiftForDate,
    getHoliday,
    getApprovedLeaveForDate,
    getApprovedPermissionForDate,
    getDeviationReview,
    getActiveCorrectionsForMonth,
    computeDayStatus,
  };
}

// Whether `correction` is past the monthly limit, given that month's pending + approved
// corrections. Full-day corrections have their own allowance and don't count here.
function correctionOverLimit(monthCorrections, correction) {
  const singles = monthCorrections.filter(c => c.kind !== 'both');
  return singles.findIndex(c => c.id === correction.id) >= CORRECTION_MONTHLY_LIMIT;
}

module.exports = {
  createAttendanceLogic,
  LAUNCH_DATE,
  GRACE_LATE_MINUTES,
  GRACE_EARLY_MINUTES,
  HALF_DAY_SATURDAYS,
  SATURDAY_HALF_SHIFT,
  CORRECTION_MONTHLY_LIMIT,
  FULL_DAY_CORRECTION_MONTHLY_LIMIT,
  correctionOverLimit,
  todayStr,
  pad,
  parseTimeToMinutes,
  timeOfDayMinutes,
  isSunday,
  isSaturday,
  saturdayOccurrenceInMonth,
  effectivePunches,
  DEFAULT_SHIFT,
  AUTO_CHECKOUT_AFTER_SHIFT_MINUTES,
  isHalfSaturday,
  dayBranchName,
  resolveShift,
  autoCheckoutTimestamp,
  autoCheckoutDue,
  dayEndTimestamp,
  mostCommonShift,
};
