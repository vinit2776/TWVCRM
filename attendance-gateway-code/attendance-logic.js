'use strict';

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

function createAttendanceLogic(db) {
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
  // (09:30-13:30) rather than being a day off. Everything else uses the employee's normal shift.
  function getShiftForDate(employee, dateStr) {
    if (isSaturday(dateStr) && HALF_DAY_SATURDAYS.includes(saturdayOccurrenceInMonth(dateStr))) {
      return SATURDAY_HALF_SHIFT;
    }
    return { start: employee.shift_start, end: employee.shift_end };
  }
  function getHoliday(dateStr) {
    return db.prepare('SELECT * FROM holidays WHERE date = ?').get(dateStr);
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
    const punches = effectivePunches(await getPunchesForDay(employeeId, dateStr));

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

    const shift = getShiftForDate(employee, dateStr);
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

    let status;
    if (punches.length % 2 !== 0) {
      status = dateStr === todayStr() ? 'Active' : 'Punch Error';
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
};
