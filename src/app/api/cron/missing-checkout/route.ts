/**
 * GET /api/cron/missing-checkout
 *
 * Runs daily at 20:30 IST (15:00 UTC).
 * For every active employee who had a check-in today but no check-out
 * (and is not on approved leave today), inserts a pending
 * attendance_correction of type 'missing_checkout'.
 *
 * HR reviews pending corrections the next morning via the attendance page.
 * Idempotent: skips if a pending/approved correction already exists for today.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Today in IST
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const todayIST = istNow.toISOString().slice(0, 10); // YYYY-MM-DD

  // Default shift end (fallback 19:00 IST if app_settings not set)
  const defaultShiftEnd = "19:00";
  const { data: settings } = await admin
    .from("app_settings")
    .select("key, value")
    .in("key", ["default_shift_end_time"]);
  const shiftEndTime = settings?.find(s => s.key === "default_shift_end_time")?.value ?? defaultShiftEnd;
  const [shiftHour, shiftMin] = shiftEndTime.split(":").map(Number);

  // Build shift-end timestamp in UTC for use as the corrected_time default
  const shiftEndUTC = new Date(
    Date.UTC(
      istNow.getFullYear(),
      istNow.getMonth(),
      istNow.getDate(),
      shiftHour - 5,
      shiftMin - 30, // convert IST to UTC
    ),
  );
  // Handle minute underflow
  if (shiftMin < 30) {
    shiftEndUTC.setUTCHours(shiftHour - 6);
    shiftEndUTC.setUTCMinutes(shiftMin + 30);
  }

  // 1. Find employees who checked in today (have at least one IN event)
  const { data: checkins } = await admin
    .from("access_logs")
    .select("entity_id")
    .eq("user_type", "employee")
    .eq("direction", "IN")
    .gte("event_time", `${todayIST}T00:00:00+05:30`)
    .lte("event_time", `${todayIST}T23:59:59+05:30`);

  if (!checkins || checkins.length === 0) {
    return NextResponse.json({ flagged: 0, message: "No check-ins today" });
  }

  const checkedInIds = [...new Set(checkins.map(r => r.entity_id).filter(Boolean))];

  // 2. Find employees who also checked out today
  const { data: checkouts } = await admin
    .from("access_logs")
    .select("entity_id")
    .eq("user_type", "employee")
    .eq("direction", "OUT")
    .gte("event_time", `${todayIST}T00:00:00+05:30`)
    .lte("event_time", `${todayIST}T23:59:59+05:30`);

  const checkedOutIds = new Set((checkouts ?? []).map(r => r.entity_id));
  const missingOutIds = checkedInIds.filter(id => !checkedOutIds.has(id));

  if (missingOutIds.length === 0) {
    return NextResponse.json({ flagged: 0, message: "All employees checked out" });
  }

  // 3. Map access_log entity_id → employee_id via biometric_user_map
  const { data: userMaps } = await admin
    .from("biometric_user_map")
    .select("employee_id, cosec_user_id")
    .in("cosec_user_id", missingOutIds);

  const cosecToEmployee = new Map<string, string>(
    (userMaps ?? []).map(m => [m.cosec_user_id, m.employee_id]),
  );
  const employeeIds = missingOutIds
    .map(id => cosecToEmployee.get(id))
    .filter((id): id is string => id !== undefined);

  if (employeeIds.length === 0) {
    return NextResponse.json({ flagged: 0, message: "No employee mappings found" });
  }

  // 4. Exclude employees on approved leave today
  const { data: onLeave } = await admin
    .from("employee_leave_requests")
    .select("employee_id")
    .eq("status", "approved")
    .lte("from_date", todayIST)
    .gte("to_date", todayIST);

  const onLeaveIds = new Set((onLeave ?? []).map(r => r.employee_id));
  const toFlag = employeeIds.filter(id => !onLeaveIds.has(id));

  if (toFlag.length === 0) {
    return NextResponse.json({ flagged: 0, message: "All missing-checkout employees are on leave" });
  }

  // 5. Exclude employees already flagged today (idempotent)
  const { data: existing } = await admin
    .from("attendance_corrections")
    .select("employee_id")
    .in("employee_id", toFlag)
    .eq("correction_date", todayIST)
    .eq("correction_type", "missing_checkout")
    .in("status", ["pending", "approved", "applied"]);

  const alreadyFlagged = new Set((existing ?? []).map(r => r.employee_id));
  const newFlags = toFlag.filter(id => !alreadyFlagged.has(id));

  if (newFlags.length === 0) {
    return NextResponse.json({ flagged: 0, message: "Already flagged today" });
  }

  // 6. Insert pending corrections
  const rows = newFlags.map(employeeId => ({
    employee_id: employeeId,
    correction_date: todayIST,
    correction_type: "missing_checkout" as const,
    corrected_time: shiftEndUTC.toISOString(),
    reason: "Auto-flagged: no checkout detected by shift end",
    status: "pending" as const,
  }));

  const { error: insertErr } = await admin.from("attendance_corrections").insert(rows);
  if (insertErr) {
    console.error("missing-checkout cron insert error:", insertErr.message);
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ flagged: newFlags.length, employees: newFlags });
}
