/**
 * Activation on a partly collected deposit.
 *
 * A contract normally needs the deposit paid in full. When the deposit is being
 * collected in parts (proposal_deposit_instalments) and MORE than half of the
 * required amount has actually been received, activation is allowed with a
 * warning that the balance is still pending. The pro-rata / first invoice is
 * unaffected — it must still be paid.
 *
 * "Required" is the adjusted deposit (amount + exception − held credit), the
 * same figure the deposit screens show. Only money received counts; an asked-for
 * part that is not yet paid does not.
 */

/** Strictly more than this share of the required deposit must be received. */
export const PARTIAL_DEPOSIT_ACTIVATION_PERCENT = 50;

export interface PartialDepositState {
  required: number;
  paid: number;
  /** Required − paid, never negative. */
  pending: number;
  /** Share received, 0–100, rounded to 1 decimal for display only. */
  percent: number;
  /** Fully paid: the normal gate applies and passes. */
  complete: boolean;
  /** More than the threshold received but not complete: may activate with a warning. */
  allowsActivation: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function partialDepositState(requiredRaw: number, paidRaw: number): PartialDepositState {
  const required = Math.max(0, round2(requiredRaw));
  const paid = Math.max(0, round2(paidRaw));
  const complete = required > 0 && paid >= required;
  // Compare in integers of paise so 50.00% exactly is never "more than 50%".
  const overHalf = required > 0 && Math.round(paid * 100) * 100 > Math.round(required * 100) * PARTIAL_DEPOSIT_ACTIVATION_PERCENT;
  return {
    required,
    paid,
    pending: Math.max(0, round2(required - paid)),
    percent: required > 0 ? Math.round((paid / required) * 1000) / 10 : 0,
    complete,
    allowsActivation: !complete && overHalf,
  };
}

/** The wording shown wherever the pending balance is warned about. */
export function partialDepositWarning(s: Pick<PartialDepositState, "paid" | "required" | "pending" | "percent">): string {
  const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
  return `Deposit pending: ${inr(s.paid)} of ${inr(s.required)} received (${s.percent}%). The balance of ${inr(s.pending)} is still to be collected.`;
}
