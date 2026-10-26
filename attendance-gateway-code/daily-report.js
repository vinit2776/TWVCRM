'use strict';

// The two daily attendance emails: who has punched in by 10:00 (shift starts 09:30), and
// who has punched out by 19:00. Built from the punches table directly rather than
// computeDayStatus(), because each report is a snapshot "as of" its cutoff: Vercel's
// Hobby cron can fire anywhere in the hour, so a 10:00 run may really start at 10:40,
// and the 19:00 run may land after the 7 PM auto-checkout. Punches after the cutoff and
// the synthetic auto-checkout are both ignored, so the email reads the same either way.
// Kept out of server.js so it can be unit-tested against an in-memory database.

const {
  GRACE_LATE_MINUTES, GRACE_EARLY_MINUTES, parseTimeToMinutes, timeOfDayMinutes, isSunday, effectivePunches,
} = require('./attendance-logic');
const { employeeBranchLabel } = require('./geofence');

const REPORTS = {
  morning: { cutoff: '10:00', title: 'Punch-in report' },
  evening: { cutoff: '19:00', title: 'Punch-out report' },
};

const SOURCE_LABELS = {
  biometric: 'Biometric', office: 'App', wifi: 'App', remote: 'Remote', correction: 'Correction',
};

function minutesBetween(fromTs, toTs) {
  return (new Date(toTs.replace(' ', 'T')).getTime() - new Date(fromTs.replace(' ', 'T')).getTime()) / 60000;
}

function createDailyReport(db, logic) {
  // Everything the report needs about one employee, as of the cutoff on dateStr.
  async function employeeSnapshot(emp, dateStr, cutoffTs) {
    const dayPunches = (await logic.getPunchesForDay(emp.id, dateStr))
      .filter(p => p.source !== 'auto' && p.timestamp <= cutoffTs);
    const punches = effectivePunches(dayPunches);
    const shift = logic.getShiftForDate(emp, dateStr);
    const base = { name: emp.name, branch: employeeBranchLabel(emp.branch), shiftStart: shift.start, shiftEnd: shift.end };
    if (punches.length === 0) {
      const leave = await logic.getApprovedLeaveForDate(emp.id, dateStr);
      return { ...base, state: leave ? 'leave' : 'absent', leaveType: leave ? leave.leave_type : null };
    }
    const checkIn = punches[0];
    const lateBy = timeOfDayMinutes(checkIn.timestamp) - parseTimeToMinutes(shift.start);
    const snap = {
      ...base,
      // Where they actually punched in, when the punch knows (remote punches don't).
      branch: checkIn.branch || (checkIn.source === 'remote' ? '' : base.branch),
      checkIn: checkIn.timestamp,
      source: SOURCE_LABELS[checkIn.source] || checkIn.source,
      lateBy: lateBy > GRACE_LATE_MINUTES ? lateBy : 0,
    };
    const breaks = await logic.getBreaksForDay(emp.id, dateStr);
    const breakMinutes = breaks
      .filter(b => b.end_ts && b.end_ts <= cutoffTs)
      .reduce((sum, b) => sum + minutesBetween(b.start_ts, b.end_ts), 0);
    if (punches.length % 2 !== 0) {
      return { ...snap, state: 'in', workedMinutes: Math.max(0, minutesBetween(checkIn.timestamp, cutoffTs) - breakMinutes) };
    }
    const checkOut = punches[punches.length - 1];
    const outMin = timeOfDayMinutes(checkOut.timestamp);
    let leftEarly = outMin < parseTimeToMinutes(shift.end) - GRACE_EARLY_MINUTES;
    // Same rule as the calendar: an approved early-leave permission excuses it, as long as
    // they didn't leave even earlier than what was approved.
    const permission = leftEarly ? await logic.getApprovedPermissionForDate(emp.id, dateStr) : null;
    if (permission && outMin >= parseTimeToMinutes(permission.leave_time)) leftEarly = false;
    return {
      ...snap,
      state: leftEarly ? 'left_early' : 'out',
      checkOut: checkOut.timestamp,
      workedMinutes: Math.max(0, minutesBetween(checkIn.timestamp, checkOut.timestamp) - breakMinutes),
    };
  }

  // { skipped } on a holiday or Sunday; otherwise the rows for that kind of report.
  async function buildReport(kind, dateStr) {
    const def = REPORTS[kind];
    if (!def) throw new Error(`Unknown report kind: ${kind}`);
    const holiday = await logic.getHoliday(dateStr);
    if (holiday) return { kind, date: dateStr, skipped: `Holiday: ${holiday.name}` };
    if (isSunday(dateStr)) return { kind, date: dateStr, skipped: 'Sunday' };

    const cutoffTs = `${dateStr} ${def.cutoff}:59`;
    const employees = (await db.prepare('SELECT * FROM employees ORDER BY name').all())
      .filter(e => !e.date_joined || e.date_joined <= dateStr);
    const rows = [];
    for (const emp of employees) rows.push(await employeeSnapshot(emp, dateStr, cutoffTs));

    const byTime = (key) => (a, b) => (a[key] || '').localeCompare(b[key] || '');
    const onLeave = rows.filter(r => r.state === 'leave');
    const absent = rows.filter(r => r.state === 'absent');
    const punchedIn = rows.filter(r => r.checkIn).sort(byTime('checkIn'));
    const report = { kind, date: dateStr, cutoff: def.cutoff, title: def.title, total: rows.length, onLeave };
    if (kind === 'morning') {
      return {
        ...report,
        notIn: absent,
        late: punchedIn.filter(r => r.lateBy),
        onTime: punchedIn.filter(r => !r.lateBy),
      };
    }
    return {
      ...report,
      stillIn: punchedIn.filter(r => r.state === 'in'),
      leftEarly: rows.filter(r => r.state === 'left_early').sort(byTime('checkOut')),
      out: rows.filter(r => r.state === 'out').sort(byTime('checkOut')),
      absent,
    };
  }

  return { buildReport };
}

// --- Email rendering. Inline styles and tables only: that's what mail clients render. ---

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function clock(ts) {
  const [h, m] = ts.split(' ')[1].split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function clock24(hhmm) {
  return clock(`x ${hhmm}`);
}
function hoursText(minutes) {
  const m = Math.round(minutes);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function longDate(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

const C = {
  text: '#1F2933', muted: '#7C8896', line: '#E4E7EB', card: '#F5F7FA',
  warnBg: '#FFF3E0', warn: '#8A4B00', badBg: '#FDECEA', bad: '#A12622',
};

function pill(text, bg, fg) {
  return `<span style="display:inline-block;background:${bg};color:${fg};border-radius:6px;padding:1px 7px;font-size:12px;">${escapeHtml(text)}</span>`;
}
function stat(n, label) {
  return `<td style="background:${C.card};border-radius:8px;padding:10px 12px;width:25%;vertical-align:top;">
    <div style="font-size:22px;font-weight:600;color:${C.text};">${n}</div>
    <div style="font-size:12px;color:${C.muted};">${escapeHtml(label)}</div></td>`;
}
// cells: [left, middle, right] HTML strings for each row.
function section(title, note, rows) {
  if (rows.length === 0) return '';
  const body = rows.map(cells => `<tr>
      <td style="padding:7px 0;border-bottom:1px solid ${C.line};color:${C.text};">${cells[0]}</td>
      <td style="padding:7px 0;border-bottom:1px solid ${C.line};color:${C.muted};text-align:right;">${cells[1] || ''}</td>
      <td style="padding:7px 0 7px 12px;border-bottom:1px solid ${C.line};color:${C.muted};text-align:right;white-space:nowrap;">${cells[2] || ''}</td>
    </tr>`).join('');
  return `<div style="font-size:14px;font-weight:600;color:${C.text};margin:20px 0 4px;">${escapeHtml(title)}
      <span style="font-weight:400;color:${C.muted};">(${rows.length})${note ? ` · ${escapeHtml(note)}` : ''}</span></div>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px;">${body}</table>`;
}
function who(r) {
  return escapeHtml(r.name);
}
function where(r, extra) {
  return escapeHtml([r.branch, extra].filter(Boolean).join(' · '));
}

function renderReportEmail(report, { deviceOfflineSince = null, appUrl = '' } = {}) {
  const heading = `${report.title} · ${longDate(report.date)} · ${clock24(report.cutoff)}`;
  const leaveRows = report.onLeave.map(r => [who(r), where(r), escapeHtml(r.leaveType || 'Leave')]);
  let stats;
  let sections;
  if (report.kind === 'morning') {
    stats = [stat(report.onTime.length + report.late.length, 'Punched in'), stat(report.late.length, `Late (${GRACE_LATE_MINUTES}+ min)`),
      stat(report.notIn.length, 'Not in yet'), stat(report.onLeave.length, 'On leave')];
    sections = [
      section('Not punched in yet', '', report.notIn.map(r => [who(r), where(r), `Shift ${clock24(r.shiftStart)}`])),
      section('Punched in late', '', report.late.map(r => [who(r), where(r, r.source), `${clock(r.checkIn)} ${pill(`+${r.lateBy}m`, C.warnBg, C.warn)}`])),
      section('On time', '', report.onTime.map(r => [who(r), where(r, r.source), clock(r.checkIn)])),
      section('On leave', '', leaveRows),
    ];
  } else {
    stats = [stat(report.out.length, 'Punched out'), stat(report.leftEarly.length, 'Left early'),
      stat(report.stillIn.length, 'Still in at 7 PM'), stat(report.absent.length, 'Absent')];
    sections = [
      section('Still punched in at 7 PM', 'the 7 PM auto-checkout closes these', report.stillIn.map(r => [who(r), where(r, `In ${clock(r.checkIn)}`), `${hoursText(r.workedMinutes)} so far`])),
      section('Left before shift end', '', report.leftEarly.map(r => [who(r), where(r, `${clock(r.checkIn)} → ${clock(r.checkOut)}`), `Shift ends ${clock24(r.shiftEnd)}`])),
      section('Punched out', '', report.out.map(r => [who(r), where(r, `${clock(r.checkIn)} → ${clock(r.checkOut)}`), hoursText(r.workedMinutes)])),
      section('Absent today', '', report.absent.map(r => [who(r), where(r), ''])),
      section('On leave', '', leaveRows),
    ];
  }
  const warning = deviceOfflineSince
    ? `<div style="background:${C.badBg};color:${C.bad};border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px;">The biometric device hasn't reached the app since ${escapeHtml(deviceOfflineSince)}. Biometric punches after that may be missing here until it reconnects.</div>`
    : '';
  const footer = appUrl
    ? `Full details in the <a href="${escapeHtml(appUrl)}/admin/attendance" style="color:${C.muted};">attendance app</a>.`
    : 'Full details in the attendance app.';
  const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#FFFFFF;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:620px;margin:0 auto;">
    <div style="font-size:18px;font-weight:600;color:${C.text};margin-bottom:4px;">${escapeHtml(heading)}</div>
    <div style="font-size:13px;color:${C.muted};margin-bottom:16px;">As of ${clock24(report.cutoff)} · ${report.total} employees</div>
    ${warning}
    <table role="presentation" cellpadding="0" cellspacing="6" style="width:100%;border-collapse:separate;margin:0 -6px;"><tr>${stats.join('')}</tr></table>
    ${sections.join('')}
    <div style="font-size:12px;color:${C.muted};margin-top:24px;">Sent automatically by TWV Attendance. ${footer}</div>
  </div></body></html>`;
  return { subject: heading, html, text: renderText(report) };
}

// Plain-text part, for clients that don't show HTML (and spam filters that want one).
function renderText(report) {
  const lines = [`${report.title} — ${longDate(report.date)}, as of ${clock24(report.cutoff)}`, ''];
  const list = (title, rows, fmt) => {
    if (rows.length === 0) return;
    lines.push(`${title} (${rows.length})`);
    for (const r of rows) lines.push(`  - ${fmt(r)}`);
    lines.push('');
  };
  if (report.kind === 'morning') {
    list('Not punched in yet', report.notIn, r => r.name);
    list('Punched in late', report.late, r => `${r.name}: ${clock(r.checkIn)} (+${r.lateBy}m)`);
    list('On time', report.onTime, r => `${r.name}: ${clock(r.checkIn)}`);
  } else {
    list('Still punched in at 7 PM', report.stillIn, r => `${r.name}: in ${clock(r.checkIn)}`);
    list('Left before shift end', report.leftEarly, r => `${r.name}: ${clock(r.checkIn)} - ${clock(r.checkOut)}`);
    list('Punched out', report.out, r => `${r.name}: ${clock(r.checkIn)} - ${clock(r.checkOut)} (${hoursText(r.workedMinutes)})`);
    list('Absent today', report.absent, r => r.name);
  }
  list('On leave', report.onLeave, r => `${r.name}: ${r.leaveType || 'Leave'}`);
  return lines.join('\n').trim() + '\n';
}

// "a@x.com, b@y.com\nc@z.com" -> ['a@x.com', 'b@y.com', 'c@z.com'], or null if any is invalid.
function parseRecipients(raw) {
  const list = String(raw || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  if (list.some(e => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) return null;
  return list;
}

// Resend's HTTP API, called directly so the gateway keeps a single dependency.
async function sendEmail({ apiKey, from, to, subject, html, text }, fetchImpl = fetch) {
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()).id;
}

module.exports = { createDailyReport, renderReportEmail, parseRecipients, sendEmail, REPORTS };
