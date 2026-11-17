import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { zodErrorResponse } from "@/lib/validations";
import { requireRole } from "@/lib/energy-alerts/auth";
import { modeSchema } from "@/lib/energy-alerts/schema";
import { ENERGY_ALERTS_MODE_SETTING, loadMode } from "@/lib/energy-alerts/evaluate";

/** Admin-only global gate. Only 'live' lets a Live rule actually send email. */
export async function PUT(request: NextRequest) {
  const auth = await requireRole(["admin"]);
  if ("error" in auth) return auth.error;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const parsed = modeSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const before = await loadMode(auth.admin);
  const { error } = await auth.admin.from("app_settings")
    .upsert({ key: ENERGY_ALERTS_MODE_SETTING, value: parsed.data.mode, updated_by: auth.userId }, { onConflict: "key" });
  if (error) return NextResponse.json({ error: "Could not change the mode" }, { status: 500 });
  await logAudit(auth.admin, { entityType: "energy_alert_rule", entityId: "00000000-0000-0000-0000-000000000000", action: "update", performedBy: auth.userId, changes: { energy_alerts_cron_mode: { old: before, new: parsed.data.mode } } });
  return NextResponse.json({ mode: parsed.data.mode });
}
