import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { zodErrorResponse } from "@/lib/validations";
import { requireRole } from "@/lib/energy-alerts/auth";
import { ENERGY_ALERT_MANAGE_ROLES, ackSchema } from "@/lib/energy-alerts/schema";

/** Acknowledge an open episode with a reason. Stops its reminders; a worsening step can still email. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireRole(ENERGY_ALERT_MANAGE_ROLES);
  if ("error" in auth) return auth.error;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const parsed = ackSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json(zodErrorResponse(parsed.error), { status: 400 });

  const { data: ep } = await auth.admin.from("energy_alert_episodes").select("id, status, acked_at").eq("id", id).maybeSingle();
  if (!ep) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  if (ep.acked_at) return NextResponse.json({ error: "Already acknowledged" }, { status: 409 });

  const { error } = await auth.admin.from("energy_alert_episodes")
    .update({ acked_at: new Date().toISOString(), acked_by: auth.userId, ack_reason: parsed.data.reason, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) return NextResponse.json({ error: "Could not acknowledge" }, { status: 500 });
  await logAudit(auth.admin, { entityType: "energy_alert_episode", entityId: id, action: "update", performedBy: auth.userId, changes: { ack_reason: { old: null, new: parsed.data.reason } } });
  return NextResponse.json({ ok: true });
}
