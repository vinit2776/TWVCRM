import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { canOverrideDepositFloor, instalmentErrorMessage } from "@/lib/deposit-instalments";
import { cancelRazorpayLink } from "@/lib/deposit-instalment-server";

/**
 * POST /api/proposals/[id]/deposit-instalments/[instalmentId]/cancel
 *
 * Withdraws an unpaid part: cancels its link at Razorpay and returns the amount
 * to "not yet asked". Allowed for whoever made the request, or an admin/manager.
 * A part that has been paid cannot be cancelled here (that is a refund).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; instalmentId: string }> },
) {
  const { id, instalmentId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).maybeSingle();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 10) {
    return NextResponse.json({ error: "Give a reason for cancelling (at least 10 characters)" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("proposal_deposit_instalments")
    .select("id, proposal_id, seq, amount, status, requested_by, razorpay_link_id")
    .eq("id", instalmentId)
    .eq("proposal_id", id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Deposit part not found" }, { status: 404 });

  if (row.requested_by !== actor.id && !canOverrideDepositFloor(actor.role)) {
    return NextResponse.json({ error: "Only the person who made this request, or a manager or admin, can cancel it" }, { status: 403 });
  }

  const { data: res, error } = await admin.rpc("cancel_deposit_instalment", {
    p_instalment_id: instalmentId, p_actor: actor.id, p_reason: reason,
  });
  if (error) {
    console.error("[deposit-instalments] cancel failed:", error.message);
    return NextResponse.json({ error: "Could not cancel the request" }, { status: 500 });
  }
  if (!res?.success) {
    return NextResponse.json({ error: instalmentErrorMessage(res?.error), code: res?.error }, { status: 409 });
  }

  await cancelRazorpayLink(admin, row.razorpay_link_id);

  void logAudit(admin, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: {
      deposit_part_cancelled: { old: { seq: row.seq, amount: row.amount }, new: null },
      reason: { old: null, new: reason },
    },
  });

  return NextResponse.json({ data: { id: instalmentId, cancelled: true } });
}
