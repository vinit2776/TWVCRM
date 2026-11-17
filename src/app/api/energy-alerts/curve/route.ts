import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addDays, istToday } from "@/lib/energy-baseline";
import { requireRole } from "@/lib/energy-alerts/auth";
import { ENERGY_ALERT_VIEW_ROLES } from "@/lib/energy-alerts/schema";
import { ALERT_BASELINE_DAYS } from "@/lib/energy-alerts/baseline";
import { buildCurvePreview } from "@/lib/energy-alerts/preview";
import { loadExcludedDates, loadHolidays, loadLedger, loadMeter } from "@/lib/energy-alerts/evaluate";

/** Read-only: the meter a rule would watch, the usual kW curve for today and today's readings so far.
 *  Powers the chart in the rule editor. Sends nothing, writes nothing. */
export async function GET(request: NextRequest) {
  const auth = await requireRole(ENERGY_ALERT_VIEW_ROLES);
  if ("error" in auth) return auth.error;
  const locationId = z.string().uuid().safeParse(request.nextUrl.searchParams.get("location_id"));
  if (!locationId.success) return NextResponse.json({ error: "location_id is required" }, { status: 400 });

  const meter = await loadMeter(auth.admin, locationId.data);
  if ("error" in meter) return NextResponse.json({ error: meter.error }, { status: 422 });
  try {
    const now = new Date();
    const from = addDays(istToday(now), -(ALERT_BASELINE_DAYS + 5));
    const [rows, holidays, excluded] = await Promise.all([
      loadLedger(auth.admin, meter.id, meter.deviceId, from),
      loadHolidays(auth.admin, meter.id, from),
      loadExcludedDates(auth.admin, meter.id, from, now),
    ]);
    return NextResponse.json({ data: { meter: { name: meter.name, deviceId: meter.deviceId }, ...buildCurvePreview(rows, holidays, excluded, now) } },
      { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[api/energy-alerts/curve] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not load the usual curve" }, { status: 500 });
  }
}
