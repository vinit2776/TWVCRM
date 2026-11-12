import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/contracts/[id]/cancel-stamp
 *
 * Admin-only undo for the "stamp with company seal" action: clears the
 * signed_document link so the contract falls back to the plain generated
 * agreement (Download PDF / Send Agreement / Email re-appear). Only allowed
 * when stamp_reference is set — i.e. the current signed_document was
 * produced by this feature, not a manually uploaded signed copy, which this
 * route must never touch.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contractId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admin can cancel the sign & seal stamp" },
      { status: 403 }
    );
  }

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, signed_document_id, stamp_reference")
    .eq("id", contractId)
    .single();

  if (!contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (!contract.stamp_reference) {
    return NextResponse.json(
      { error: "This contract's signed document wasn't produced by the stamp feature — nothing to cancel." },
      { status: 400 }
    );
  }

  const { data: updated, error: updateErr } = await supabase
    .from("contracts")
    .update({ signed_document_id: null, stamp_reference: null })
    .eq("id", contractId)
    .select("*")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "contract",
    entityId: contractId,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      action: { old: null, new: "sign_seal_cancelled" },
      signed_document_id: { old: contract.signed_document_id, new: null },
      stamp_reference: { old: contract.stamp_reference, new: null },
    },
  });

  return NextResponse.json({ data: updated });
}
