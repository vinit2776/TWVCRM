import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/contracts/[id]/deposit-topups/[topupId]/cancel — admin only.
 *
 * Closes a PENDING top-up that should never have gone out (wrong amount,
 * wrong contract, customer settled another way). Previously the only way to
 * clear one was to settle it and then reverse it, which fabricated a payment
 * that never happened; meanwhile the row kept ageing in AR and kept being
 * chased by the follow-up ladder.
 *
 * A PAID top-up is not cancellable — that goes through the reverse endpoint
 * so the shortfall restore and audit trail stay correct.
 *
 * Also cancels the Razorpay link (best-effort) so the customer can't still
 * pay a request we've withdrawn.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; topupId: string }> }
) {
  const { id: contractId, topupId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!actor || actor.role !== "admin") {
    return NextResponse.json({ error: "Only admin can cancel a deposit top-up" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return NextResponse.json({ error: "A cancellation reason is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: topup } = await admin
    .from("deposit_topups")
    .select("id, status, razorpay_payment_link_id")
    .eq("id", topupId)
    .eq("contract_id", contractId)
    .single();

  if (!topup) return NextResponse.json({ error: "Top-up not found" }, { status: 404 });

  const { data: rpcResult, error: rpcError } = await admin.rpc("cancel_deposit_topup", {
    p_topup_id: topupId,
    p_cancelled_by: actor.id,
    p_reason: reason,
  });
  if (rpcError) return NextResponse.json({ error: rpcError.message }, { status: 500 });

  const result = rpcResult?.[0];
  if (!result?.success) {
    return NextResponse.json({ error: result?.error || "Could not cancel top-up" }, { status: 422 });
  }

  // Withdraw the payment link so the customer can't pay a cancelled request.
  // Best-effort: an already-expired or already-paid link failing to cancel
  // must not fail the operation — the DB state is what AR and the ladder
  // read from, and a late payment would be caught by the webhook's
  // status guard anyway.
  if (topup.razorpay_payment_link_id) {
    try {
      const { data: rzpSettings } = await admin
        .from("app_settings").select("key, value")
        .in("key", ["razorpay_key_id", "razorpay_key_secret"]);
      const rzp: Record<string, string> = {};
      (rzpSettings || []).forEach((s) => { rzp[s.key] = s.value; });

      if (rzp.razorpay_key_id && rzp.razorpay_key_secret) {
        const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");
        await fetch(
          `https://api.razorpay.com/v1/payment_links/${topup.razorpay_payment_link_id}/cancel`,
          { method: "POST", headers: { Authorization: `Basic ${auth}` } },
        );
      }
    } catch (err) {
      console.error("[topup/cancel] Razorpay link cancel failed (non-fatal):", err);
    }
  }

  await logAudit(admin, {
    entityType: "deposit_topup",
    entityId: topupId,
    action: "deposit_topup_cancelled",
    performedBy: actor.id,
    changes: {
      status: { old: "pending", new: "cancelled" },
      reason: { old: null, new: reason },
    },
  });

  return NextResponse.json({ data: { id: topupId, status: "cancelled" } });
}
