import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { zodErrorResponse } from "@/lib/validations";
import { requireRole } from "@/lib/energy-alerts/auth";
import { ENERGY_ALERT_MANAGE_ROLES, rulePatchSchema } from "@/lib/energy-alerts/schema";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireRole(ENERGY_ALERT_MANAGE_ROLES);
  if ("error" in auth) return auth.error;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const parsed = rulePatchSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const { data: before } = await auth.admin.from("energy_alert_rules").select("*").eq("id", id).maybeSingle();
  if (!before) return NextResponse.json({ error: "Rule not found" }, { status: 404 });

  // Changing what counts as a deviation starts the judging afresh: a streak built under the old
  // numbers must not carry over. Open episodes are untouched.
  const judging = ["tolerance_pct", "min_kw", "direction", "persist_slots", "location_id"] as const;
  const reset = judging.some((k) => k in parsed.data && parsed.data[k] !== before[k])
    ? { streak_slots: 0, streak_dir: 0, streak_kwh: 0 } : {};

  const { data, error } = await auth.admin.from("energy_alert_rules")
    .update({ ...parsed.data, ...reset, updated_at: new Date().toISOString() }).eq("id", id).select("*").single();
  if (error) {
    console.error("[api/energy-alerts/rules/[id]] update failed:", error.message);
    return NextResponse.json({ error: "Could not update the rule" }, { status: 500 });
  }
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const [k, v] of Object.entries(parsed.data)) if (JSON.stringify(before[k]) !== JSON.stringify(v)) changes[k] = { old: before[k], new: v };
  if (Object.keys(changes).length > 0) await logAudit(auth.admin, { entityType: "energy_alert_rule", entityId: id, action: "update", performedBy: auth.userId, changes });
  return NextResponse.json({ data });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireRole(ENERGY_ALERT_MANAGE_ROLES);
  if ("error" in auth) return auth.error;
  const { data: before } = await auth.admin.from("energy_alert_rules").select("name").eq("id", id).maybeSingle();
  if (!before) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  const { error } = await auth.admin.from("energy_alert_rules").delete().eq("id", id);
  if (error) {
    console.error("[api/energy-alerts/rules/[id]] delete failed:", error.message);
    return NextResponse.json({ error: "Could not delete the rule" }, { status: 500 });
  }
  await logAudit(auth.admin, { entityType: "energy_alert_rule", entityId: id, action: "delete", performedBy: auth.userId, changes: { name: { old: before.name, new: null } } });
  return NextResponse.json({ ok: true });
}
