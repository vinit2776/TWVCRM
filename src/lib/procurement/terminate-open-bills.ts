/**
 * Bills left behind when an AMC is terminated.
 *
 * A terminated AMC can never be paid again, so a bill still waiting for approval on it is dead weight:
 * it sits in the payables queue and its invoice number blocks the same invoice being uploaded on the
 * replacement AMC ("already exists"). Those bills are withdrawn with the termination. A bill that is
 * approved or has a real payment is money someone already acted on, so it is left alone and reported.
 */

export interface TerminationBill {
  id: string;
  bill_number: string;
  invoice_number: string | null;
  approval_status: string;
  amount_paid: number;
  /** Sum of the bill's own payment records that have not been reversed. */
  payments: number;
  electricity_bill_id: string | null;
}

export interface TerminationBillPlan {
  withdraw: TerminationBill[];
  /** Live bills that need a person: approved, or carrying a real payment. */
  keep: Array<{ bill: TerminationBill; why: string }>;
}

const DEAD = new Set(["rejected", "withdrawn"]);

/** `includeApproved`: an admin clearing a retired AMC also withdraws approved bills that have no real payment. */
export function planTerminationBills(bills: TerminationBill[], includeApproved = false): TerminationBillPlan {
  const withdraw: TerminationBill[] = [];
  const keep: TerminationBillPlan["keep"] = [];
  for (const b of bills) {
    if (DEAD.has(b.approval_status)) continue;
    if (b.payments > 0) {
      keep.push({ bill: b, why: "has a payment recorded — reverse it first" });
    } else if (b.approval_status === "approved" && !includeApproved) {
      keep.push({ bill: b, why: "is approved — un-approve it, then withdraw" });
    } else if (!["pending", "approved"].includes(b.approval_status) || b.electricity_bill_id) {
      keep.push({ bill: b, why: "cannot be withdrawn automatically" });
    } else {
      withdraw.push(b);
    }
  }
  return { withdraw, keep };
}
