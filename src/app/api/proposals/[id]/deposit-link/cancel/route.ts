import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/proposals/[id]/deposit-link/cancel
 *
 * Withdraws a security-deposit payment link: cancels it at Razorpay so the
 * customer can no longer pay it, clears the link off the proposal, and
 * records who withdrew it and why.
 *
 * Deposit top-ups have had this since they were built
 * (/api/contracts/[id]/deposit-topups/[topupId]/cancel). Proposal deposits
 * never did, so a link once issued stayed payable indefinitely — including on
 * proposals that were later rejected, where paying it would have resurrected
 * a dead deal.
 *
 * This cancels the *demand*, not the debt. If the deposit is genuinely no
 * longer owed, that is a waiver (/deposit-waiver-otp) or a credit
 * (/deposit-credit); both are separate decisions with their own approvals.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).maybeSingle();
  // Admin only, matching the top-up cancel. Withdrawing a payment link the
  // customer may be about to use is not a routine edit.
  if (!actor || actor.role !== "admin") {
    return NextResponse.json(
      { error: "Only an admin can cancel a deposit payment link" },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return NextResponse.json({ error: "A cancellation reason is required" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: proposal } = await admin
    .from("proposals")
    .select("id, proposal_number, status, deposit_payment_status, deposit_razorpay_link_id, deposit_razorpay_link_url, deposit_link_cancelled_at")
    .eq("id", id)
    .maybeSingle();

  if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

  // Cancelling after the money has arrived would hide a real payment behind a
  // "withdrawn" note.
  if (proposal.deposit_payment_status === "paid") {
    return NextResponse.json(
      { error: "This deposit is already paid — there is no live link to cancel" },
      { status: 409 },
    );
  }
  if (proposal.deposit_link_cancelled_at) {
    return NextResponse.json({ error: "This link is already cancelled" }, { status: 409 });
  }
  if (!proposal.deposit_razorpay_link_id && !proposal.deposit_razorpay_link_url) {
    return NextResponse.json({ error: "There is no deposit link on this proposal" }, { status: 400 });
  }

  const now = new Date().toISOString();

  const { error: updErr } = await admin
    .from("proposals")
    .update({
      deposit_razorpay_link_id: null,
      deposit_razorpay_link_url: null,
      deposit_link_cancelled_at: now,
      deposit_link_cancelled_by: actor.id,
      deposit_link_cancel_reason: reason,
    })
    .eq("id", id)
    // Don't race a concurrent cancellation into two audit rows.
    .is("deposit_link_cancelled_at", null);

  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  /**
   * Cancel at Razorpay too, best effort.
   *
   * Deliberately after the DB write and deliberately non-fatal, matching the
   * top-up cancel: our own state is what the AR page and the chase ladder
   * read, and a late payment against a link Razorpay didn't manage to cancel
   * is still caught by the webhook's status guard. Failing the whole
   * operation because Razorpay was briefly unreachable would leave the link
   * live *and* uncancelled here, which is the worse of the two outcomes.
   */
  if (proposal.deposit_razorpay_link_id) {
    try {
      const { data: settings } = await admin
        .from("app_settings").select("key, value")
        .in("key", ["razorpay_key_id", "razorpay_key_secret"]);
      const rzp: Record<string, string> = {};
      (settings || []).forEach((s) => { rzp[s.key as string] = s.value as string; });

      if (rzp.razorpay_key_id && rzp.razorpay_key_secret) {
        const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");
        const res = await fetch(
          `https://api.razorpay.com/v1/payment_links/${proposal.deposit_razorpay_link_id}/cancel`,
          { method: "POST", headers: { Authorization: `Basic ${auth}` } },
        );
        if (!res.ok) {
          console.warn(
            `[deposit-link/cancel] Razorpay refused to cancel ${proposal.deposit_razorpay_link_id} (${res.status}) — ` +
            `link cleared locally on ${proposal.proposal_number}`,
          );
        }
      }
    } catch (err) {
      console.warn("[deposit-link/cancel] Razorpay cancel failed:", err);
    }
  }

  void logAudit(admin, {
    entityType: "proposal",
    entityId: id,
    action: "update",
    performedBy: actor.id,
    changes: {
      deposit_link_cancelled: { old: proposal.deposit_razorpay_link_id, new: null },
      reason: { old: null, new: reason },
      proposal_status_at_cancellation: { old: null, new: proposal.status },
    },
  });

  return NextResponse.json({ data: { id, cancelled_at: now } });
}
