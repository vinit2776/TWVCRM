import { SupabaseClient } from "@supabase/supabase-js";
import { evaluateAutoApproval, type RecentBillLike, type RecurringBillRuleLike } from "./recurring-bill-rules";
import { computeBatchDate, toISODateString } from "@/lib/payment-batch";
import { generateSignedApprovalCode } from "@/lib/procurement/approval-code";
import { logAudit } from "@/lib/audit";
import type { PaymentBatchType } from "@/types";

interface RecurringRuleRow extends RecurringBillRuleLike {
  id: string;
  default_batch_type: PaymentBatchType;
}

export interface AutoApproveOutcome {
  autoApproved: boolean;
  note?: string;
}

const DUPLICATE_LOOKBACK_DAYS = 90;

/**
 * Called right after a bill is created (still approval_status="pending").
 * If the vendor has an active recurring rule, runs the guardrails and — if
 * they all pass — flips the bill straight to approved, matching what a human
 * approver would otherwise have to do by hand every cycle.
 */
export async function tryAutoApproveBill(
  supabase: SupabaseClient,
  billId: string,
  vendorId: string,
): Promise<AutoApproveOutcome> {
  const { data: rule } = await supabase
    .from("procurement_recurring_bill_rules")
    .select("id, expected_amount, tolerance_percent, max_auto_approve_amount, first_bill_id, default_batch_type")
    .eq("vendor_id", vendorId)
    .eq("status", "active")
    .maybeSingle<RecurringRuleRow>();

  if (!rule) return { autoApproved: false };

  const { data: bill } = await supabase
    .from("vendor_bills")
    .select("id, total_amount, invoice_number, invoice_date")
    .eq("id", billId)
    .single();
  if (!bill) return { autoApproved: false };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DUPLICATE_LOOKBACK_DAYS);
  const { data: recentBillsRaw } = await supabase
    .from("vendor_bills")
    .select("id, invoice_number, invoice_date, total_amount")
    .eq("vendor_id", vendorId)
    .neq("id", billId)
    .neq("approval_status", "rejected")
    .gte("invoice_date", toISODateString(cutoff));

  const recentBills: RecentBillLike[] = (recentBillsRaw ?? []).map((b) => ({
    id: b.id,
    invoice_number: b.invoice_number,
    invoice_date: b.invoice_date,
    total_amount: Number(b.total_amount),
  }));

  const result = evaluateAutoApproval(
    rule,
    {
      total_amount: Number(bill.total_amount),
      invoice_number: bill.invoice_number,
      invoice_date: bill.invoice_date,
    },
    recentBills,
  );

  if (!result.approved) return { autoApproved: false, note: result.note };

  const { count: approvedCount } = await supabase
    .from("vendor_bills")
    .select("*", { count: "exact", head: true })
    .eq("approval_status", "approved");
  const approvalCode = generateSignedApprovalCode("bill", (approvedCount ?? 0) + 1, billId);

  const batchDate = computeBatchDate(rule.default_batch_type);
  const now = new Date().toISOString();

  const { error: updateError } = await supabase
    .from("vendor_bills")
    .update({
      approval_status: "approved",
      approved_by: null,
      approved_at: now,
      approval_code: approvalCode,
      approved_amount: Number(bill.total_amount),
      base_amount: Number(bill.total_amount),
      payment_batch_type: rule.default_batch_type,
      payment_batch_date: toISODateString(batchDate),
      payment_batch_assigned_at: now,
      auto_approved: true,
      recurring_rule_id: rule.id,
      auto_approval_note: result.note,
    })
    .eq("id", billId);

  if (updateError) {
    console.error("[recurring-bill-rules] auto-approve update failed:", updateError.message);
    return { autoApproved: false, note: result.note };
  }

  await logAudit(supabase, {
    entityType: "vendor_bill",
    entityId: billId,
    action: "update",
    performedBy: null,
    changes: {
      approval_status: { old: "pending", new: "approved" },
      auto_approved: { old: false, new: true },
      recurring_rule_id: { old: null, new: rule.id },
    },
  });

  return { autoApproved: true, note: result.note };
}

/**
 * Called on manual approval of any bill. If the vendor's active rule hasn't
 * had its first post-rule bill confirmed yet, this bill becomes that
 * confirmation — every later bill against the rule becomes eligible to
 * auto-approve.
 */
export async function confirmFirstBillIfNeeded(
  supabase: SupabaseClient,
  billId: string,
  vendorId: string,
): Promise<void> {
  const { data: rule } = await supabase
    .from("procurement_recurring_bill_rules")
    .select("id, first_bill_id")
    .eq("vendor_id", vendorId)
    .eq("status", "active")
    .is("first_bill_id", null)
    .maybeSingle();

  if (!rule) return;

  await supabase
    .from("procurement_recurring_bill_rules")
    .update({ first_bill_id: billId })
    .eq("id", rule.id);
}
