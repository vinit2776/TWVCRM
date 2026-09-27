import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * WHY "rejected" + rejection_outcome="void" instead of a new approval_status:
 *
 * `vendor_bills.approval_status` is a fixed enum (pending/approved/rejected)
 * and `rejection_outcome` already carries a CHECK constraint that includes
 * 'void' as a valid value (migration 00052_bill_approval_workflow.sql) — it
 * was added for exactly this purpose but never wired up to an action. Every
 * downstream consumer of approval_status (billing rollups, dashboards, the
 * "pending approval" queues, push notifications) already knows how to treat
 * a "rejected" bill as inert/terminal, so reusing that status means voiding
 * needs zero changes to any reporting or list-filtering code and needs no
 * schema migration. `rejection_outcome = "void"` is what distinguishes a
 * true rejection (bill was wrong, resubmit it) from a void (bill was right,
 * but the whole thing is being reversed) — see the "reject" vs "void" cases
 * in src/app/api/procurement/bills/[id]/route.ts.
 *
 * Do NOT introduce a new approval_status value ("voided") for this — it would
 * require a migration and would silently break every existing `.eq("approval_status", "rejected")`
 * / `.neq("approval_status", "rejected")` filter across the codebase that assumes
 * rejected is the only terminal non-approved state.
 */

/**
 * Returns a human-readable blocker message if this bill cannot be voided,
 * or null if voiding is allowed. Governing rule: cancellation/void is allowed
 * as long as no money has moved (no recorded payment); it is hard-blocked
 * the moment any payment has been recorded. TDS is treated as "money moved"
 * too, since a filed TDS entry may already be reported in a 26Q.
 */
export async function getBillVoidBlocker(
  supabase: SupabaseClient,
  billId: string
): Promise<string | null> {
  const { data: bill, error } = await supabase
    .from("vendor_bills")
    .select("id, bill_number, approval_status, amount_paid")
    .eq("id", billId)
    .single();

  if (error || !bill) {
    return "Bill not found.";
  }

  if (!["pending", "approved"].includes(bill.approval_status)) {
    return `${bill.bill_number} is already ${bill.approval_status} and cannot be voided.`;
  }

  const amountPaid = Number(bill.amount_paid ?? 0);

  const { count: paymentCount, data: payments } = await supabase
    .from("vendor_bill_payments")
    .select("amount", { count: "exact" })
    .eq("bill_id", billId);

  if (amountPaid > 0 || (paymentCount ?? 0) > 0) {
    // Prefer the bill's own running total; fall back to summing payment rows
    // in case amount_paid is out of sync with the payments table for any reason.
    const displayAmount = amountPaid > 0
      ? amountPaid
      : (payments ?? []).reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
    return `Bill ${bill.bill_number} has ₹${displayAmount.toLocaleString("en-IN")} recorded against it. Reverse the payment before voiding.`;
  }

  const { count: tdsCount } = await supabase
    .from("vendor_bill_tds")
    .select("id", { count: "exact", head: true })
    .eq("bill_id", billId);

  if ((tdsCount ?? 0) > 0) {
    return `Bill ${bill.bill_number} has a TDS entry recorded, which may already be reported in a filed 26Q and cannot be reversed by a status flip. Reverse the TDS entry before voiding.`;
  }

  return null;
}

/**
 * Void a single vendor bill. Performs its own blocker check — callers do not
 * need to call getBillVoidBlocker first (though they may want to, to surface
 * the blocker message before attempting the write).
 */
export async function voidBill(
  supabase: SupabaseClient,
  opts: { billId: string; actorId: string; reason: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { billId, actorId, reason } = opts;

  const blocker = await getBillVoidBlocker(supabase, billId);
  if (blocker) {
    return { ok: false, error: blocker };
  }

  const { data: bill, error: fetchError } = await supabase
    .from("vendor_bills")
    .select("id, approval_status, rejection_outcome, rejection_reason, payment_hold_status")
    .eq("id", billId)
    .single();

  if (fetchError || !bill) {
    return { ok: false, error: "Bill not found." };
  }

  const now = new Date().toISOString();

  const updatePayload: Record<string, unknown> = {
    approval_status: "rejected",
    rejection_outcome: "void",
    rejection_reason: reason,
    approved_by: actorId,
    approved_at: now,
    // Clear payment-batch scheduling — a voided bill must not show up in any
    // upcoming payment batch.
    payment_batch_type: null,
    payment_batch_date: null,
    payment_batch_assigned_by: null,
    payment_batch_assigned_at: null,
  };

  // Mirror the release_hold case's field writes (bills/[id]/route.ts) so a
  // voided bill that was on hold doesn't stay stuck "on hold" forever.
  if (bill.payment_hold_status === "on_hold") {
    updatePayload.payment_hold_status = "none";
    updatePayload.payment_hold_resolved_by = actorId;
    updatePayload.payment_hold_resolved_at = now;
    updatePayload.payment_hold_resolution_notes = `Bill voided: ${reason}`;
  }

  const { error: updateError } = await supabase
    .from("vendor_bills")
    .update(updatePayload)
    .eq("id", billId);

  if (updateError) {
    return { ok: false, error: updateError.message };
  }

  // Pause any recurring bill rule anchored to this bill — a rule anchored to
  // a voided bill must not keep auto-approving future bills from the vendor.
  await supabase
    .from("procurement_recurring_bill_rules")
    .update({ status: "paused" })
    .eq("anchor_bill_id", billId)
    .eq("status", "active");

  await logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: billId,
    action: "update",
    performedBy: actorId,
    changes: {
      approval_status: { old: bill.approval_status, new: "rejected" },
      rejection_outcome: { old: bill.rejection_outcome ?? null, new: "void" },
      void_reason: { old: null, new: reason },
    },
  });

  return { ok: true };
}
