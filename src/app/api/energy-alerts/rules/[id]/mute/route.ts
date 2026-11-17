import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { zodErrorResponse } from "@/lib/validations";
import { requireRole } from "@/lib/energy-alerts/auth";
import { ENERGY_ALERT_MANAGE_ROLES, muteSchema } from "@/lib/energy-alerts/schema";

/** Mute a rule for N hours (0 clears it). While muted, decisions are still recorded but nothing is emailed. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireRole(ENERGY_ALERT_MANAGE_ROLES);
  if ("error" in auth) return auth.error;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const parsed = muteSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const until = parsed.data.hours > 0 ? new Date(Date.now() + parsed.data.hours * 3_600_000).toISOString() : null;
  const { error, count } = await auth.admin.from("energy_alert_rules")
    .update({ muted_until: until, updated_at: new Date().toISOString() }, { count: "exact" }).eq("id", id);
  if (error) return NextResponse.json({ error: "Could not mute the rule" }, { status: 500 });
  if (!count) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  await logAudit(auth.admin, { entityType: "energy_alert_rule", entityId: id, action: "update", performedBy: auth.userId, changes: { muted_until: { old: null, new: until } } });
  return NextResponse.json({ muted_until: until });
}
