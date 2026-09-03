import { SupabaseClient } from "@supabase/supabase-js";
import { computeBatchDate, toISODateString } from "@/lib/payment-batch";
import { generateSignedApprovalCode } from "@/lib/procurement/approval-code";
import { logAudit } from "@/lib/audit";
import type { PaymentBatchType } from "@/types";

export interface AmcAutoApproveOutcome {
  autoApproved: boolean;
  note?: string;
}

/**
 * Called right after a bill is created against a service PO (still
 * approval_status="pending").
 *
 * An AMC contract is approved exactly once, at the material request stage —
 * that approval fixes the vendor, the total value, and the cycle count. Every
 * invoice after that just has to prove it belongs to an already-agreed cycle:
 * the amount is already hard-capped at unit_cost_per_cycle by the bill-create
 * route, and it can only exist against a service report the vendor actually
 * delivered. So once the contract's very first invoice has been through one
 * manual approval, later cycles don't need a human to re-approve the same
 * contract terms again — they auto-approve straight through, same as a human
 * approver would otherwise do by hand every cycle.
 *
 * The first invoice on a contract is always manual — it's the only chance to
 * catch a wrong vendor, wrong cycle cost, or bad setup before it repeats.
 * `manualReviewRequested` lets the uploader opt a specific later invoice back
 * into manual review (e.g. an amount or date that looks off), even once the
 * contract is otherwise trusted.
 */
export async function tryAutoApproveAmcBill(
  supabase: SupabaseClient,
  billId: string,
  poId: string,
  manualReviewRequested: boolean,
): Promise<AmcAutoApproveOutcome> {
  if (manualReviewRequested) {
    return { autoApproved: false, note: "Flagged for manual review at upload" };
  }

  const { data: po } = await supabase
    .from("purchase_orders")
    .select("id, po_number, po_type, amc_start_date")
    .eq("id", poId)
    .single();
  if (!po || po.po_type !== "service" || !po.amc_start_date) {
    return { autoApproved: false };
  }

  const { data: priorBills } = await supabase
    .from("vendor_bills")
    .select("id, approval_status, payment_batch_type")
    .eq("po_id", poId)
    .neq("id", billId)
    .neq("approval_status", "rejected");

  if (!priorBills || priorBills.length === 0) {
    return { autoApproved: false, note: "First invoice on this AMC contract — always manual" };
  }
  const approvedPrior = priorBills.find((b) => b.approval_status === "approved");
  if (!approvedPrior) {
    return { autoApproved: false, note: "Waiting on the first invoice's approval before later cycles can auto-approve" };
  }

  const { data: bill } = await supabase
    .from("vendor_bills")
    .select("id, total_amount")
    .eq("id", billId)
    .single();
  if (!bill) return { autoApproved: false };

  const { count: approvedCount } = await supabase
    .from("vendor_bills")
    .select("*", { count: "exact", head: true })
    .eq("approval_status", "approved");
  const approvalCode = generateSignedApprovalCode("bill", (approvedCount ?? 0) + 1, billId);

  // Carry forward whatever payment cadence the contract's first approved
  // invoice used, rather than guessing a default.
  const batchType = (approvedPrior.payment_batch_type ?? "15th") as PaymentBatchType;
  const batchDate = computeBatchDate(batchType);
  const now = new Date().toISOString();
  const note = `Auto-approved — ${po.po_number} is an AMC contract already approved for this cycle's cost; a prior invoice on this contract was approved manually.`;

  const { error } = await supabase
    .from("vendor_bills")
    .update({
      approval_status: "approved",
      approved_by: null,
      approved_at: now,
      approval_code: approvalCode,
      approved_amount: Number(bill.total_amount),
      base_amount: Number(bill.total_amount),
      payment_batch_type: batchType,
      payment_batch_date: toISODateString(batchDate),
      payment_batch_assigned_at: now,
      auto_approved: true,
      auto_approval_note: note,
    })
    .eq("id", billId);

  if (error) {
    console.error("[amc-bill-auto-approve] auto-approve update failed:", error.message);
    return { autoApproved: false, note };
  }

  await logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: billId,
    action: "update",
    performedBy: null,
    changes: {
      approval_status: { old: "pending", new: "approved" },
      auto_approved: { old: false, new: true },
    },
  });

  return { autoApproved: true, note };
}
