import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/contracts/[id]/deposit-topups/[topupId]/reverse — admin-only
 * correction for a mistaken top-up. Restores the shortfall figure (if the
 * top-up had applied to it) and the top-up drops out of the available
 * balance automatically, since that's computed live from paid rows only.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; topupId: string }> }
) {
  const { id: contractId, topupId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json({ error: "Only admin can reverse a deposit top-up" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return NextResponse.json({ error: "A reversal reason is required" }, { status: 400 });

  const admin = createAdminClient();

  const { data: topup } = await admin
    .from("deposit_topups")
    .select("id")
    .eq("id", topupId)
    .eq("contract_id", contractId)
    .single();

  if (!topup) return NextResponse.json({ error: "Top-up not found" }, { status: 404 });

  const { data: rpcResult, error: rpcError } = await admin.rpc("reverse_deposit_topup", {
    p_topup_id: topupId,
    p_reversed_by: dbUser.id,
    p_reason: reason,
  });
  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

  const result = rpcResult?.[0];
  if (!result?.success) {
    return NextResponse.json({ error: result?.error || "Could not reverse top-up" }, { status: 422 });
  }

  await logAudit(admin, {
    entityType: "deposit_topup",
    entityId: topupId,
    action: "deposit_topup_reversed",
    performedBy: dbUser.id,
    changes: { status: { old: "paid", new: "reversed" }, reason: { old: null, new: reason } },
  });

  return NextResponse.json({ data: { id: topupId, status: "reversed" } });
}
