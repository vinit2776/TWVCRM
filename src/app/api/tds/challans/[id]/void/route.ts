import { chainLockedResponse } from "@/lib/procurement/chain-lock";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { rollbackReasonSchema } from "@/lib/procurement/admin-rollback";
import { requireRollbackAdmin } from "@/lib/procurement/admin-rollback-server";

const bodySchema = z.object({ reason: rollbackReasonSchema });

// void_tds_challan (00604) raises these as the exception message.
const RPC_ERRORS: Record<string, { status: number; message: string }> = {
  CHALLAN_NOT_FOUND: { status: 404, message: "Challan not found" },
  CHALLAN_ALREADY_VOIDED: { status: 409, message: "This challan has already been voided" },
};

/**
 * POST /api/tds/challans/[id]/void
 * Admin only. Voids a challan entered in error: every TDS entry on it goes back
 * to pending so it can be put on the right challan. The challan row is kept.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const gate = await requireRollbackAdmin("Only an admin can void a TDS challan");
  if ("error" in gate) return gate.error;
  const { supabase, dbUser } = gate;

  // A challan can carry TDS for bills in several cycles; none may be locked.
  const { data: onChallan } = await supabase.from("vendor_bill_tds").select("bill_id").eq("challan_id", id);
  for (const billId of new Set((onChallan ?? []).map((t) => t.bill_id as string))) {
    const lockedChain = await chainLockedResponse(supabase, { billId });
    if (lockedChain) return lockedChain;
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "A reason is required" }, { status: 400 });
  }

  const { data: result, error } = await createAdminClient().rpc("void_tds_challan", {
    p_challan_id: id,
    p_actor: dbUser.id,
    p_reason: parsed.data.reason,
  });
  if (error) {
    const known = Object.entries(RPC_ERRORS).find(([code]) => error.message.includes(code));
    if (known) return NextResponse.json({ error: known[1].message }, { status: known[1].status });
    console.error(`[tds/challans/${id}] void failed:`, error.message);
    return NextResponse.json({ error: "Could not void the challan" }, { status: 500 });
  }

  await logAudit(supabase, {
    entityType: "tds_challan",
    entityId: id,
    action: "rollback",
    performedBy: dbUser.id,
    changes: {
      rollback_kind: { old: null, new: "challan_voided" },
      rollback_reason: { old: null, new: parsed.data.reason },
      challan_ref: { old: result?.challan_ref, new: null },
      entries_released: { old: null, new: result?.entries_released ?? 0 },
    },
  });

  return NextResponse.json({ data: result });
}
