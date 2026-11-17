import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/energy-alerts/auth";
import { ENERGY_ALERT_VIEW_ROLES } from "@/lib/energy-alerts/schema";

/** Recent episodes (newest first) with the emails each one produced. Optional ?rule_id=. */
export async function GET(request: NextRequest) {
  const auth = await requireRole(ENERGY_ALERT_VIEW_ROLES);
  if ("error" in auth) return auth.error;
  const ruleId = request.nextUrl.searchParams.get("rule_id");

  let q = auth.admin.from("energy_alert_episodes")
    .select("*, rule:energy_alert_rules(name, mode), location:locations(name), events:energy_alert_events(id, kind, status, slot_ts, subject, dev_pct, actual_kw, typical_kw)")
    .order("started_at", { ascending: false }).limit(50);
  if (ruleId) q = q.eq("rule_id", ruleId);
  const { data, error } = await q;
  if (error) {
    console.error("[api/energy-alerts/episodes] read failed:", error.message);
    return NextResponse.json({ error: "Failed to load episodes" }, { status: 500 });
  }
  return NextResponse.json({ data: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}
