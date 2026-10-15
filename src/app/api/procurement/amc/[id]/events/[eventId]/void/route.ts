import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { rollbackReasonSchema } from "@/lib/procurement/admin-rollback";
import { requireRollbackAdmin } from "@/lib/procurement/admin-rollback-server";

const bodySchema = z.object({ reason: rollbackReasonSchema });

// void_amc_event (00604) raises these as the exception message.
const RPC_ERRORS: Record<string, { status: number; message: string }> = {
  EVENT_NOT_FOUND: { status: 404, message: "Visit not found" },
  EVENT_ALREADY_VOIDED: { status: 409, message: "This visit has already been voided" },
};

/**
 * POST /api/procurement/amc/[id]/events/[eventId]/void
 * Admin only. Marks a logged visit voided (kept in history) and, for a counted
 * visit type, gives the covered visit back to the contract.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> }
) {
  const { id: poId, eventId } = await params;
  const gate = await requireRollbackAdmin("Only an admin can void a logged visit");
  if ("error" in gate) return gate.error;
  const { supabase, dbUser } = gate;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "A reason is required" }, { status: 400 });
  }

  // The RPC keys on the event id alone, so make sure it belongs to the PO in the URL.
  const admin = createAdminClient();
  const { data: ev } = await admin
    .from("amc_service_events")
    .select("id, po_id, event_number, event_type")
    .eq("id", eventId)
    .maybeSingle();
  if (!ev || ev.po_id !== poId) return NextResponse.json({ error: "Visit not found on this contract" }, { status: 404 });

  const { data: result, error } = await admin.rpc("void_amc_event", {
    p_event_id: eventId,
    p_actor: dbUser.id,
    p_reason: parsed.data.reason,
  });
  if (error) {
    const known = Object.entries(RPC_ERRORS).find(([code]) => error.message.includes(code));
    if (known) return NextResponse.json({ error: known[1].message }, { status: known[1].status });
    console.error(`[amc/${poId}] void visit failed:`, error.message);
    return NextResponse.json({ error: "Could not void the visit" }, { status: 500 });
  }

  await logAudit(supabase, {
    entityType: "purchase_order",
    entityId: poId,
    action: "rollback",
    performedBy: dbUser.id,
    changes: {
      rollback_kind: { old: null, new: "amc_visit_voided" },
      rollback_reason: { old: null, new: parsed.data.reason },
      amc_event_voided: { old: null, new: `Event #${ev.event_number}: ${ev.event_type}` },
      ...(result?.counted && { amc_visits_used: { old: result.previous_visits_used, new: result.visits_used } }),
    },
  });

  return NextResponse.json({ data: result });
}
