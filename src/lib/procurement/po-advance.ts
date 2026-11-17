import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How much of a PO's advance has been used, and what is left.
 *
 * "Applied" is the standing advance payment lines on the PO's bills. "Legacy credit" is money
 * older bills show as paid without any payment line (the pre-credit that gave every bill the
 * whole advance); it counts as used, so an advance that was already credited can never be
 * applied a second time. Mirrors po_advance_unused() in migration 00721, which is the check
 * that actually enforces it.
 */
export interface AdvanceUsage {
  advance: number;
  applied: number;
  legacyCredit: number;
  unused: number;
}

export function advanceUsage(input: {
  advance: number;
  appliedLines: number[];
  /** Per live bill: amount_paid and the sum of its standing payment lines (advance lines included). */
  bills: Array<{ amountPaid: number; linesSum: number }>;
}): AdvanceUsage {
  const applied = round2(input.appliedLines.reduce((s, a) => s + a, 0));
  const legacyCredit = round2(input.bills.reduce((s, b) => s + Math.max(0, b.amountPaid - b.linesSum), 0));
  const unused = Math.max(0, round2(input.advance - applied - legacyCredit));
  return { advance: round2(input.advance), applied, legacyCredit, unused };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Reads a PO's bills and payment lines and works out its advance usage. Use the admin client. */
export async function loadAdvanceUsage(admin: SupabaseClient, poId: string): Promise<AdvanceUsage> {
  const { data: po } = await admin.from("purchase_orders").select("advance_amount").eq("id", poId).maybeSingle();
  const { data: bills } = await admin
    .from("vendor_bills")
    .select("id, amount_paid, approval_status")
    .eq("po_id", poId)
    .not("approval_status", "in", "(rejected,withdrawn)");
  const ids = (bills ?? []).map((b) => b.id as string);
  const { data: lines } = ids.length
    ? await admin.from("vendor_bill_payments").select("bill_id, amount, advance_po_id").in("bill_id", ids).is("reversed_at", null)
    : { data: [] as Array<{ bill_id: string; amount: number; advance_po_id: string | null }> };
  const sums = new Map<string, number>();
  for (const l of lines ?? []) sums.set(l.bill_id as string, (sums.get(l.bill_id as string) ?? 0) + Number(l.amount));
  const { data: appliedRows } = await admin
    .from("vendor_bill_payments").select("amount").eq("advance_po_id", poId).is("reversed_at", null);
  return advanceUsage({
    advance: Number(po?.advance_amount ?? 0),
    appliedLines: (appliedRows ?? []).map((r) => Number(r.amount)),
    bills: (bills ?? []).map((b) => ({ amountPaid: Number(b.amount_paid ?? 0), linesSum: sums.get(b.id as string) ?? 0 })),
  });
}

/** What the apply route tells the user for each refusal the database function can raise. */
export const APPLY_ADVANCE_ERRORS: Record<string, { status: number; message: string }> = {
  NO_PO: { status: 422, message: "This bill is not on a purchase order, so there is no advance to apply." },
  BILL_NOT_APPROVED: { status: 422, message: "Approve the bill first. An advance can only be applied to an approved bill." },
  ADVANCE_NOT_PROCESSED: { status: 422, message: "The PO's advance has not been paid yet. Record it in Acc Payables first." },
  ADVANCE_NO_REFERENCE: { status: 422, message: "The PO's advance has no payment reference (UTR or cheque number), so it cannot be applied. Add the reference to the advance first." },
  AMOUNT_INVALID: { status: 400, message: "Enter an amount above zero." },
  EXCEEDS_UNUSED_ADVANCE: { status: 422, message: "That is more than the unused part of the advance. Check how much of it earlier bills already used." },
  EXCEEDS_BILL_OUTSTANDING: { status: 422, message: "That is more than this bill still owes (invoice plus GST, less what is paid)." },
};
