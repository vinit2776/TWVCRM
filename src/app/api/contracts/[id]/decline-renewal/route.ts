import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/contracts/[id]/decline-renewal
 *
 * Marks a contract as "renewal declined" with a reason.
 * The contract stays in its current status (active/expired) —
 * it simply records the customer's decision not to renew.
 *
 * Body: { reason: string }
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
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 401 });

  const body = await request.json();
  const reason = (body.reason || "").trim();
  if (!reason) {
    return NextResponse.json({ error: "Decline reason is required" }, { status: 400 });
  }

  // Fetch the contract
  const { data: contract, error: fetchErr } = await supabase
    .from("contracts")
    .select("id, contract_number, status, renewal_declined")
    .eq("id", id)
    .single();

  if (fetchErr || !contract) {
    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  // Only active or expired contracts can be declined
  if (!["active", "expired"].includes(contract.status)) {
    return NextResponse.json({
      error: `Cannot decline renewal for a ${contract.status} contract`,
    }, { status: 400 });
  }

  if (contract.renewal_declined) {
    return NextResponse.json({
      error: "Renewal has already been declined for this contract",
    }, { status: 409 });
  }

  const now = new Date().toISOString();

  const { data: updated, error: updateErr } = await supabase
    .from("contracts")
    .update({
      renewal_declined: true,
      renewal_declined_reason: reason,
      renewal_declined_at: now,
      renewal_declined_by: dbUser.id,
    })
    .eq("id", id)
    .select("id, contract_number, renewal_declined, renewal_declined_reason, renewal_declined_at")
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  logAudit(supabase, {
    entityType: "contract",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      renewal_declined: { old: false, new: true },
      renewal_declined_reason: { old: null, new: reason },
    },
  });

  return NextResponse.json({ data: updated });
}
