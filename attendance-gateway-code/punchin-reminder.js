'use strict';

// Punch-in reminder emails: each employee who hasn't punched in gets one email 10
// minutes after their shift starts, 5 minutes before the 15-minute grace ends. Times
// follow each person's own shift (and the short 2nd/4th-Saturday shift).
//
// Something has to call this every few minutes. Vercel's Hobby cron can't (it runs at
// most daily and lands anywhere in the hour), so /internal/punchin-reminder is called
// by an outside every-5-minute schedule, and also on the biometric device's check-ins.
// Each run only sends what is due right now; punchin_reminder_runs stops repeats.
//
// The admin setting PUNCHIN_REMINDER_WINDOW decides when runs may send anything:
//   fixed  — 09:30 to 10:00 only. Covers the standard 09:30 shift.
//   shifts — from the earliest shift start to the latest grace end among today's
//            employees, so later and earlier shifts get reminded too.
// Kept out of server.js so it can be unit-tested against an in-memory database.

const {
  GRACE_LATE_MINUTES, parseTimeToMinutes, isSunday,
} = require('./attendance-logic');

const REMINDER_BEFORE_GRACE_ENDS_MINUTES = 5;
const REMINDER_AFTER_SHIFT_START_MINUTES = GRACE_LATE_MINUTES - REMINDER_BEFORE_GRACE_ENDS_MINUTES;
const FIXED_WINDOW = { start: '09:30', end: '10:00' };
const WINDOW_MODES = ['fixed', 'shifts'];

// { start, end } in minutes of the day, inclusive. shiftStarts are today's shift starts
// (minutes) of the employees who could get a reminder.
function reminderWindow(mode, shiftStarts) {
  if (mode === 'shifts') {
    if (shiftStarts.length === 0) return null;
    return { start: Math.min(...shiftStarts), end: Math.max(...shiftStarts) + GRACE_LATE_MINUTES };
  }
  return { start: parseTimeToMinutes(FIXED_WINDOW.start), end: parseTimeToMinutes(FIXED_WINDOW.end) };
}

function createPunchinReminder(db, logic) {
  // Who should get a reminder at nowMin (minutes of the day) on dateStr. Returns
  // { skipped } on a holiday or Sunday, otherwise { window, due: [...] }.
  async function dueReminders(dateStr, nowMin, mode) {
    const holiday = await logic.getHoliday(dateStr);
    if (holiday) return { skipped: `Holiday: ${holiday.name}` };
    if (isSunday(dateStr)) return { skipped: 'Sunday' };

    const employees = (await db.prepare('SELECT * FROM employees ORDER BY name').all())
      .filter(e => !e.date_joined || e.date_joined <= dateStr)
      .filter(e => e.email && String(e.email).trim());
    const withShift = employees.map(emp => {
      const shift = logic.getShiftForDate(emp, dateStr);
      return { emp, shift, startMin: parseTimeToMinutes(shift.start) };
    });
    const window = reminderWindow(mode, withShift.map(s => s.startMin));
    if (!window || nowMin < window.start || nowMin > window.end) return { window, due: [] };

    const due = [];
    for (const { emp, shift, startMin } of withShift) {
      const remindAt = startMin + REMINDER_AFTER_SHIFT_START_MINUTES;
      const graceEnd = startMin + GRACE_LATE_MINUTES;
      // Only between the reminder time and the end of grace: after that the email's
      // "grace ends at…" would already be wrong, so a late run sends nothing.
      if (nowMin < remindAt || nowMin >= graceEnd) continue;
      if (remindAt < window.start || remindAt > window.end) continue;
      const punches = (await logic.getPunchesForDay(emp.id, dateStr)).filter(p => p.source !== 'auto');
      if (punches.length > 0) continue;
      if (await logic.getApprovedLeaveForDate(emp.id, dateStr)) continue;
      due.push({
        employeeId: emp.id, name: emp.name, email: String(emp.email).trim(),
        shiftStart: shift.start, remindAt, graceEnd,
      });
    }
    return { window, due };
  }

  return { dueReminders };
}

// --- Email ---

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function clockFromMinutes(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function renderReminderEmail({ name, remindAt, graceEnd }, { appUrl = '' } = {}) {
  const firstName = String(name).trim().split(/\s+/)[0] || 'there';
  const grace = clockFromMinutes(graceEnd);
  const by = clockFromMinutes(remindAt);
  const subject = 'Reminder to punch-in.';
  const button = appUrl
    ? `<p style="margin:0 0 16px;"><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#1565C0;color:#FFFFFF;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;">Punch in now &rarr;</a></p>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#FFFFFF;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;font-size:15px;line-height:1.55;color:#1F2933;">
    <p style="margin:0 0 16px;">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 16px;">You haven&rsquo;t punched in yet today. If you&rsquo;re in the office, please punch in now.</p>
    <p style="margin:0 0 16px;">The grace period ends at <strong>${grace}</strong>. A punch-in after that is marked <strong>Late</strong>.</p>
    ${button}
    <p style="margin:0 0 16px;">If you&rsquo;re on leave or working remotely today, you can ignore this email.<br>&mdash; The Work Villa Attendance</p>
    <p style="margin:24px 0 0;padding-top:14px;border-top:1px solid #E4E7EB;font-size:12px;color:#6B7684;">This is an automated reminder. You&rsquo;re getting it because no punch-in was recorded for you by ${by}.</p>
  </div></body></html>`;
  const text = [
    `Hi ${firstName},`,
    '',
    "You haven't punched in yet today. If you're in the office, please punch in now.",
    '',
    `The grace period ends at ${grace}. A punch-in after that is marked Late.`,
    ...(appUrl ? ['', `Punch in now: ${appUrl}`] : []),
    '',
    "If you're on leave or working remotely today, you can ignore this email.",
    '— The Work Villa Attendance',
    '',
    `This is an automated reminder. You're getting it because no punch-in was recorded for you by ${by}.`,
  ].join('\n');
  return { subject, html, text };
}

module.exports = {
  createPunchinReminder, renderReminderEmail, reminderWindow,
  REMINDER_AFTER_SHIFT_START_MINUTES, FIXED_WINDOW, WINDOW_MODES,
};
