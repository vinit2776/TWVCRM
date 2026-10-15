import { formatCurrency } from "@/lib/utils";

/**
 * What accounts are told when a payment would credit a statement beyond what
 * it still owes. The decision itself is made in the database
 * (record_billing_payment_guarded, 00603) under a row lock; this only words it.
 *
 * The wording matters: the commonest cause is the same receipt being recorded
 * twice, and the right next step then is to link the existing payment rather
 * than record another.
 */
export const OVERPAYMENT_CODE = "OVERPAYMENT";

export function overpaymentMessage(args: {
  outstanding: number;
  settled: number;
  attempted: number;
}): string {
  const { outstanding, settled, attempted } = args;
  if (outstanding <= 0) {
    return (
      `This invoice is already fully paid (${formatCurrency(settled)} recorded), so another ` +
      `${formatCurrency(attempted)} would over-credit the customer. If this is the same receipt, ` +
      `it is already recorded — link the existing payment instead of recording it again.`
    );
  }
  return (
    `Only ${formatCurrency(outstanding)} is still due on this invoice, and ${formatCurrency(attempted)} ` +
    `would over-credit it. Record up to ${formatCurrency(outstanding)}, or check whether part of this ` +
    `receipt is already recorded.`
  );
}
