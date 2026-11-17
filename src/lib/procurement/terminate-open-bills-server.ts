import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import { planTerminationBills, type TerminationBill } from "@/lib/procurement/terminate-open-bills";

export interface TerminationBillsResult {
  withdrawn: string[];
  left: Array<{ bill_number: string; why: string }>;
}

/**
 * Withdraws the unpaid, unapproved bills of a terminated AMC and reports the ones that still need a person.
 * `admin` must be a service client: the caller (admin or manager) is already authorised to terminate.
 */
export async function withdrawOpenBillsOfTerminatedAmc(
  admin: SupabaseClient,
  poId: string,
  userId: string,
  reason: string,
  includeApproved = false,
): Promise<TerminationBillsResult> {
  const { data: rows } = await admin
    .from("vendor_bills")
    .select("id, bill_number, invoice_number, approval_status, amount_paid, electricity_bill_id")
    .eq("po_id", poId);
  const ids = (rows ?? []).map((r) => r.id as string);
  const paid = new Map<string, number>();
  if (ids.length) {
    const { data: pays } = await admin
      .from("vendor_bill_payments")
      .select("bill_id, amount")
      .in("bill_id", ids)
      .is("reversed_at", null);
    for (const p of pays ?? []) paid.set(p.bill_id as string, (paid.get(p.bill_id as string) ?? 0) + Number(p.amount));
  }
  const bills: TerminationBill[] = (rows ?? []).map((r) => ({
    id: r.id as string,
    bill_number: r.bill_number as string,
    invoice_number: (r.invoice_number as string | null) ?? null,
    approval_status: r.approval_status as string,
    amount_paid: Number(r.amount_paid ?? 0),
    payments: paid.get(r.id as string) ?? 0,
    electricity_bill_id: (r.electricity_bill_id as string | null) ?? null,
  }));

  const plan = planTerminationBills(bills, includeApproved);
  const withdrawn: string[] = [];
  const withdrawnAt = new Date().toISOString();
  for (const b of plan.withdraw) {
    // The status guard makes a parallel approval win instead of being overwritten.
    const { data: done } = await admin
      .from("vendor_bills")
      .update({
        approval_status: "withdrawn",
        withdrawn_at: withdrawnAt,
        withdrawn_by: userId,
        withdrawn_reason: `AMC terminated: ${reason}`,
        // Any advance credit on it never left the bank; clear it with the bill.
        amount_paid: 0,
        payment_status: "unpaid",
        rejection_outcome: null,
        approval_code: null,
        approved_by: null,
        approved_at: null,
        payment_batch_type: null,
        payment_batch_date: null,
        payment_batch_assigned_by: null,
        payment_batch_assigned_at: null,
        payment_hold_status: "none",
      })
      .eq("id", b.id)
      .eq("approval_status", b.approval_status)
      .select("id");
    if (!done?.length) continue;
    withdrawn.push(b.bill_number);
    await logAudit(admin, {
      entityType: "vendor_bill",
      entityId: b.id,
      action: "rollback",
      performedBy: userId,
      changes: {
        approval_status: { old: b.approval_status, new: "withdrawn" },
        rollback_kind: { old: null, new: "bill_withdrawn" },
        rollback_reason: { old: null, new: `AMC terminated: ${reason}` },
      },
    });
  }
  return { withdrawn, left: plan.keep.map((k) => ({ bill_number: k.bill.bill_number, why: k.why })) };
}
