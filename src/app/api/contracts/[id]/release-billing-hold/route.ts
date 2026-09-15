import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { BILLING_HOLD_ALLOWED_ROLES } from "@/lib/constants";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/contracts/[id]/release-billing-hold
 *
 * Clears a hold placed via POST .../billing-hold, restoring the contract to
 * normal rent/usage generation. There is no other way off a hold.
 *
 * Guards: admin/manager only (same as placing a hold); must currently be held.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !BILLING_HOLD_ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json(
      { error: "Only admin or manager can release a billing hold on a contract" },
      { status: 403 }
    );
  }

  const { data: contract, error: fetchErr } = await supabase
    .from("contracts")
    .select("id, billing_hold_at, billing_hold_reason")
    .eq("id", id)
    .single();

  if (fetchErr || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (!contract.billing_hold_at) {
    return NextResponse.json({ error: "Contract is not on a billing hold" }, { status: 422 });
  }

  const previousReason = contract.billing_hold_reason;

  const { data: updated, error: updateErr } = await supabase
    .from("contracts")
    .update({ billing_hold_at: null, billing_hold_by: null, billing_hold_reason: null })
    .eq("id", id)
    .select("id, billing_hold_at, billing_hold_by, billing_hold_reason")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "contract_billing_hold_released",
    performedBy: dbUser.id,
    changes: { billing_hold_reason: { old: previousReason, new: null } },
  });

  return NextResponse.json(updated);
}
