import { NextRequest, NextResponse } from "next/server";
import { addDays, istToday } from "@/lib/energy-baseline";
import { zodErrorResponse } from "@/lib/validations";
import { requireRole } from "@/lib/energy-alerts/auth";
import { ENERGY_ALERT_VIEW_ROLES, backtestSchema } from "@/lib/energy-alerts/schema";
import { backtestRule } from "@/lib/energy-alerts/backtest";
import { LEDGER_LOOKBACK_DAYS, loadHolidays, loadLedger, loadMeter } from "@/lib/energy-alerts/evaluate";

/** Read-only: what these settings would have done over the last 14 days of the real ledger. Sends nothing, writes nothing. */
export async function POST(request: NextRequest) {
  const auth = await requireRole(ENERGY_ALERT_VIEW_ROLES);
  if ("error" in auth) return auth.error;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const parsed = backtestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });
  const p = parsed.data;

  const meter = await loadMeter(auth.admin, p.location_id);
  if ("error" in meter) return NextResponse.json({ error: meter.error }, { status: 422 });
  try {
    const from = addDays(istToday(), -LEDGER_LOOKBACK_DAYS);
    const [rows, holidays] = await Promise.all([loadLedger(auth.admin, meter.id, meter.deviceId, from), loadHolidays(auth.admin, meter.id, from)]);
    const data = backtestRule(rows, holidays, {
      tolerancePct: p.tolerance_pct, minKw: p.min_kw, direction: p.direction, persistSlots: p.persist_slots,
      recoverSlots: p.recover_slots, reminder: p.reminder_schedule,
    }, p.daily_cap);
    return NextResponse.json({ data });
  } catch (err) {
    console.error("[api/energy-alerts/backtest] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not check against history" }, { status: 500 });
  }
}
