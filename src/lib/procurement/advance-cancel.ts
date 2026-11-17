/**
 * Cancelling a PO advance that was never paid.
 *
 * An advance marked "processed" is credited to the PO's bills as `amount_paid`, with no payment record of its own.
 * Cancelling it must not leave a bill showing money that never left the bank. A live bill carrying such credit is
 * refused (it must be withdrawn or rejected first, so a real shortfall is never hidden); a rejected or withdrawn
 * bill is out of play, so its stale credit is cleared and its payment state recomputed from its real payments only.
 */

export interface AdvanceBill {
  id: string;
  bill_number: string;
  approval_status: string;
  total_amount: number;
  gst_amount: number | null;
  amount_paid: number;
  /** Sum of the bill's own payment records that have not been reversed. */
  payments: number;
}

export interface CreditClear {
  id: string;
  bill_number: string;
  credit: number;
  amount_paid: { from: number; to: number };
  payment_status: "unpaid" | "partially_paid" | "paid";
}

export interface AdvanceCancelPlan {
  blockers: string[];
  clears: CreditClear[];
}

const DEAD = new Set(["rejected", "withdrawn"]);
const round2 = (n: number) => Math.round(n * 100) / 100;
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export function planAdvanceCancel(bills: AdvanceBill[]): AdvanceCancelPlan {
  const blockers: string[] = [];
  const clears: CreditClear[] = [];
  for (const b of bills) {
    const credit = round2(Math.max(0, Number(b.amount_paid) - Number(b.payments)));
    if (credit <= 0) continue;
    if (!DEAD.has(b.approval_status)) {
      blockers.push(`${b.bill_number} still shows ${inr(credit)} paid without a payment of its own. Reject or withdraw it first, or record its real payment.`);
      continue;
    }
    const owed = round2(Number(b.total_amount) + Number(b.gst_amount ?? 0));
    const to = round2(Number(b.payments));
    clears.push({
      id: b.id,
      bill_number: b.bill_number,
      credit,
      amount_paid: { from: round2(Number(b.amount_paid)), to },
      payment_status: to <= 0 ? "unpaid" : to + 0.01 >= owed ? "paid" : "partially_paid",
    });
  }
  return { blockers, clears };
}
