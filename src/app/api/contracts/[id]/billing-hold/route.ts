import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { BILLING_HOLD_ALLOWED_ROLES } from "@/lib/constants";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/contracts/[id]/billing-hold
 *
 * Pauses ALL future billing for a contract — generateRentProformas and
 * generateUsageStatements both skip a held contract entirely, so no new
 * rent proforma or usage statement is generated for it until the hold is
 * released via .../release-billing-hold. Already-generated statements are
 * unaffected (use the per-statement hold at
 * /api/billing-statements/[id]/hold for that, a different, narrower
 * concept — see the migration's comment for how the two relate).
 *
 * Guards:
 *   • admin/manager only (same as Terminate and other contract-level
 *     administrative actions)
 *   • A reason is required — this pauses real billing, same bar as the
 *     statement-level hold
 *   • Not already held
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
      { error: "Only admin or manager can place a billing hold on a contract" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({})) as { reason?: string };
  const reason = body.reason?.trim();

  if (!reason) {
    return NextResponse.json({ error: "A reason for the hold is required" }, { status: 400 });
  }

  const { data: contract, error: fetchErr } = await supabase
    .from("contracts")
    .select("id, billing_hold_at")
    .eq("id", id)
    .single();

  if (fetchErr || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  if (contract.billing_hold_at) {
    return NextResponse.json({ error: "Contract is already on a billing hold" }, { status: 422 });
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateErr } = await supabase
    .from("contracts")
    .update({ billing_hold_at: now, billing_hold_by: dbUser.id, billing_hold_reason: reason })
    .eq("id", id)
    .select("id, billing_hold_at, billing_hold_by, billing_hold_reason")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "contract_billing_held",
    performedBy: dbUser.id,
    changes: { billing_hold_reason: { old: null, new: reason } },
  });

  return NextResponse.json(updated);
}
