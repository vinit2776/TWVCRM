# Attendance Gateway — Flow of Events & Feature Ideas

Written 2026-07-30. Source: direct read of `server.js` (1254 lines) as it
stands today. Goal: map how attendance actually flows through the system,
name the gaps in that flow, and propose features for the admin and employee
views aimed at one outcome — an effortless, smooth attendance flow for both
sides.

## Flow of events (current lifecycle, as built)

```
Biometric device / on-site punch
        │
        ▼
POST /api/punch (no auth today) ──▶ toggle in/out based on last punch
        │
        ▼
computeDayStatus() ── runs on-demand, not stored ──▶ derives status from:
        │                                             punches + shift + holiday
        │                                             + Sunday + approved leave
        │                                             + approved permission
        ▼
Dashboard / Calendar / Admin views render the derived status
        │
        ├──▶ 7pm (AUTO_CHECKOUT_HOUR): unmatched punch-in gets synthetic punch-out
        │
Employee: /leave/apply or /permission/apply ──▶ pending row
        │
        ▼
Admin: /leave/decide or /permission/decide (approve/reject)
        │
        ├──▶ approved leave: balance deducted, notification sent
        └──▶ rejected: notification sent, no balance change
```

## If-this-then-that scenarios

### What the code already handles
(`computeDayStatus()`, server.js:218-292)

| If | Then |
|---|---|
| No punches, date is a holiday | Status: Holiday |
| No punches, date is Sunday | Status: Week Off |
| No punches, approved leave covers the date | Status: On Leave |
| No punches, date < `LAUNCH_DATE` | Status: Present (assumes pre-launch days were fine) |
| No punches, date is future | Status: Upcoming |
| No punches, date is today/past, post-launch | Status: Absent |
| Odd punch count, today | Status: In Progress (live timer) |
| Odd punch count, past date | Status: Punch Error |
| Check-out earlier than shift end − grace, no covering permission | Status: Half Day |
| Check-out earlier than shift end − grace, but an approved permission's leave time is ≤ check-out | Excused — not Half Day |
| Check-in later than shift start + grace | Status: Late |
| 2nd or 4th Saturday of the month | Shift shrinks to 09:30-13:30 |

### What it doesn't handle — real gaps, found by tracing the logic

| If | Then (today) | Problem |
|---|---|---|
| Approved leave spans a Sunday | Sunday shows "Week Off," not "On Leave" | `countLeaveDays()` still deducts that Sunday from the leave balance — balance shrinks for a day that displays as free. Same mismatch for a holiday inside a leave range. |
| A punch comes in "Punch Error" (odd count, past date) | Nothing — it just sits wrong forever | No correction path for the employee or admin. `marked_by` column already exists on punches (built for exactly this) but nothing writes to it. |
| Device double-scans (two "in" taps in a row) | Second tap is read as "out" | No signal ever catches this; status quietly miscomputes. |
| Admin wants to add a new hire | No route exists | The only 5 employees + admin are hardcoded at first boot (server.js:106-119). There is no create-employee anywhere. |
| Admin wants to change someone's shift hours | No route exists | `shift_start`/`shift_end` are only ever set at that same one-time seed. |
| Admin wants to add a public holiday | No route exists | `holidays` table exists and is read (`getHoliday`, server.js:178), but nothing anywhere inserts into it — confirmed by grep, not assumed. |
| Grace periods / Saturday half-shift need to differ by team | Global constants (`GRACE_LATE_MINUTES` etc.) | Hardcoded in server.js:9-13, same for everyone, no UI. |

That last row is worth calling out directly: the whole reason this app exists
(per the earlier `/office-hours` design doc) is that the vendor tool was too
rigid to customize. Right now these rules are exactly as hardcoded here as
they were there — just hardcoded in a file this team owns instead of a
vendor's config panel.

## Feature ideas

### Employee view

1. **Punch-error self-correction request** — instead of a silent "Punch
   Error," let the employee submit "I actually checked out at 6:15, the
   scanner glitched," admin approves. Reuses the existing but currently
   unused `marked_by` column. Highest-leverage employee fix — right now a
   bad punch has no way back.
2. **Missed-punch reminder** — a nudge (in-app banner, or push if this ever
   gets a mobile shell) if no punch is detected shortly after shift start.
   Cuts down on false Late/Absent marks from people who just forgot to tap.
3. **Withdraw a pending request** — leave/permission requests can't be
   un-submitted today; a same-day "cancel that" button avoids an admin
   having to manually reject something the employee already regrets.
4. **One combined "request time off" flow** — leave and permission are two
   separate, disconnected screens today; employees have to know which one
   applies. Merge into one flow that asks "full day or partial?" and routes
   accordingly.
5. **Saturday half-shift banner** — the 2nd/4th Saturday rule is genuinely
   easy to forget; surface it on the dashboard the morning of, not buried in
   calendar colors.
6. **Personal monthly digest** — "This month: 18 present, 2 late, 1 half
   day, 3 leave days used" — passive visibility instead of clicking through
   the calendar to piece it together.

### Admin view

1. **Add/edit employee** — the actual top-priority gap. An admin cannot
   onboard a new hire or update anyone's shift hours without editing code.
   Everything else in this list is polish; this one blocks the app from
   being usable past the 5 seeded test employees.
2. **Holiday calendar management** — same severity class: the holiday logic
   is fully built and completely inert because nothing can ever populate
   the table.
3. **Configurable grace/shift rules** — move `GRACE_LATE_MINUTES`,
   `GRACE_EARLY_MINUTES`, `HALF_DAY_SATURDAYS` from hardcoded constants to
   an admin-editable settings screen (per-org or per-team). Directly serves
   the original reason this app was built instead of buying a vendor tool.
4. **Punch correction tool** — the admin-side counterpart to employee
   self-correction: directly view/fix a bad punch, with `marked_by`
   recording who changed it and why (audit trail, not silent overwrite).
5. **Bulk approve/reject** — leave/permission queues are one-row-at-a-time
   today (`/leave/decide?id=X`); for an admin managing more than a handful
   of people, batch action is the difference between a chore and a
   non-event.
6. **Attendance anomaly digest** — a daily/weekly rollup of
   Late/Absent/Punch-Error counts per employee, pushed to the admin rather
   than requiring them to click through every date on the calendar.
7. **Export for payroll** — CSV/PDF of attendance for a date range. Useful
   standalone, and it's effectively a manual stopgap for the CRM-sync
   project (see `docs/designs/security-hardening.md` and the prior
   `/office-hours` design doc) before that sync layer is built.

## Overtime handling (org decisions, 2026-07-30)

Three decisions locked in by the org:
- Overtime requires **pre-approval**, before the work happens — not
  detected and reviewed after the fact.
- Approved overtime does **not** credit Comp Off or any leave balance —
  stays fully decoupled from `leave_balances`.
- Admin must be able to see how many overtime hours an employee has
  **actually worked**, not just requested.

### Flow

```
Employee submits overtime pre-approval request (date + planned hours/reason)
        │
        ▼
Admin approves/rejects — BEFORE the date (mirrors leave/permission decide exactly)
        │
        ├──▶ approved → date is "authorized for overtime"
        └──▶ rejected → no authorization

[on the actual day]
        │
        ▼
Employee punches in/out as normal (biometric or on-site)
        │
        ▼
computeDayStatus() computes ACTUAL overtime minutes worked:
  max(0, hoursWorked - scheduledShiftHours) — same shift/grace math already
  in use (including the Saturday half-shift), excluding auto-checkout
  punches (source = 'auto'), floored to the nearest 15 min
        │
        ▼
Cross-referenced against approved overtime_requests for that employee+date:
  ├──▶ worked AND was approved  → Authorized overtime
  └──▶ worked, NOT approved     → Unauthorized overtime — flagged, not hidden
```

Actual hours are tracked regardless of authorization status. The point of
admin visibility is catching the gap between "we approved 1 hour" and "they
stayed 3," or catching overtime that was never approved at all — that's the
real cost-control signal a pre-approval policy exists to produce.

Overtime is computed independently from Half Day status, off the same punch
list — the two signals don't cancel each other out (same reasoning as
Late/Present already coexisting with a separate half-day flag).

### Data model addition

New table, same shape as `leave_requests`/`permission_requests` — no changes
to `leave_balances`, by design:
```sql
CREATE TABLE overtime_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL,
  date TEXT NOT NULL,
  planned_hours REAL,
  reason TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  decided_at TEXT
);
```

### Employee view additions
- "Request Overtime" form (parallel to leave/permission apply): date,
  planned hours or expected end time, reason.
- Pending/approved/rejected status, same pattern as the existing
  leave/permission screens.
- Dashboard: today's actual overtime, if any, tagged "Authorized" or
  "Unauthorized — no approved request on file."
- Monthly digest gains an overtime line: hours worked, split
  authorized/unauthorized.

### Admin view additions
- "Overtime Requests" queue — approve/reject pending pre-approval requests,
  same UI shape as the existing leave/permission decide pages (and a
  natural fit for the bulk-approve feature already proposed above).
- **Overtime hours report** — per-employee cumulative overtime hours over a
  date range (this week/month/custom), split authorized vs unauthorized.
  This is the direct answer to "admin should see how many hours of overtime
  an employee has worked." Pairs with the CSV export for payroll feature
  already proposed — overtime hours are exactly the kind of data payroll
  needs, tracked here but paid externally, same as the base attendance data.
- Unauthorized overtime should be visually distinct in that report — it's
  the actual cost-control signal the pre-approval policy exists to surface.

## Suggested sequencing

1. Add/edit employee + holiday management — nothing else matters if the app
   can't onboard real people or real holidays.
2. Punch/leave/permission correction and withdrawal — closes the "no way
   back" gaps that make small mistakes permanent.
3. Configurable grace/shift rules — the customization this app was built
   for in the first place.
4. Overtime pre-approval + reporting — new but small: one table, one
   request/decide flow reusing existing patterns, one report.
5. Digests, bulk actions, export — genuine quality-of-life once the base is
   usable end to end.

This is a working idea list, not a committed plan — no premise challenge,
alternatives, or scope decisions have been run against it yet.
