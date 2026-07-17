import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/billing-statements/[id]/deposit-adjustment — request a deposit
 * adjustment against this statement (accounts only). Does not touch
 * billing_payments or the deposit balance yet — that only happens once an
 * admin/manager approves via PATCH /api/contracts/[id]/deposit-adjustments/[adjustmentId].
 *
 * For a split payment (deposit covers part, another mode covers the rest),
 * the client records the non-deposit leg first via the existing
 * POST /api/billing-statements/[id]/payment (that leg is real cash/bank
 * movement and settles immediately, no approval needed), then calls this
 * endpoint for the deposit leg. Two calls, one combined UI action — this
 * route only ever needs to know about the deposit portion.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: statementId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "accounts") {
    return NextResponse.json(
      { error: "Only the accounts role can request a deposit adjustment" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const amount = Number(body.amount);
  const notifyCustomer = body.notify_customer === true;

  if (!amount || amount <= 0) {
    return NextResponse.json({ error: "Amount must be positive" }, { status: 400 });
  }

  const { data: statement } = await supabase
    .from("billing_statements")
    .select("id, contract_id, status")
    .eq("id", statementId)
    .single();

  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });

  const admin = createAdminClient();
  const { data: rpcResult, error: rpcError } = await admin.rpc("request_deposit_adjustment", {
    p_contract_id: statement.contract_id,
    p_billing_statement_id: statementId,
    p_amount: amount,
    p_requested_by: dbUser.id,
    p_notify_customer: notifyCustomer,
  });

  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

  const result = rpcResult?.[0];
  if (!result?.success) {
    return NextResponse.json(
      { error: result?.error || "Could not create deposit adjustment request" },
      { status: 422 }
    );
  }

  await logAudit(admin, {
    entityType: "deposit_adjustment",
    entityId: result.adjustment_id,
    action: "deposit_adjustment_requested",
    performedBy: dbUser.id,
    changes: {
      amount: { old: null, new: amount },
      billing_statement_id: { old: null, new: statementId },
      contract_id: { old: null, new: statement.contract_id },
    },
  });

  return NextResponse.json({
    data: { id: result.adjustment_id, available_after: result.available_after },
  });
}
