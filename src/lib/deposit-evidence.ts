/**
 * The customer's deposit pool (get_deposit_available_balance, 00502) sums every
 * contract marked `paid`, trusting the recorded amount. Some of those rows were
 * never evidenced by a real receipt: the August 2025 import stamped contracts
 * "Legacy — payment assumed received pre-application", and a few others were
 * marked paid with no amount at all (the pool then falls back to the required
 * amount). This module spots those so the "Apply pooled deposit" preview can
 * warn before money nobody has verified is used to unblock an activation.
 */

export interface PoolDepositContractRow {
  contract_number: string | null;
  deposit_payment_status: string | null;
  deposit_payment_amount: number | null;
  security_deposit_amount: number | null;
  deposit_refunded_amount: number | null;
  deposit_payment_reference: string | null;
}

export const LEGACY_DEPOSIT_REFERENCE_PREFIX = "legacy";

/** Paid, but no real payment evidence: a legacy "assumed" stamp or no recorded amount. */
export function isUnverifiedDeposit(row: PoolDepositContractRow): boolean {
  if (row.deposit_payment_status !== "paid") return false;
  const ref = (row.deposit_payment_reference ?? "").trim().toLowerCase();
  return ref.startsWith(LEGACY_DEPOSIT_REFERENCE_PREFIX) || row.deposit_payment_amount == null;
}

// Mirrors the per-contract term in get_deposit_available_balance so the split
// here adds up to the same `available` the RPC reports.
function collected(row: PoolDepositContractRow): number {
  if (row.deposit_payment_status !== "paid") return 0;
  const gross = Number(row.deposit_payment_amount ?? row.security_deposit_amount ?? 0);
  return Math.max(gross - Number(row.deposit_refunded_amount ?? 0), 0);
}

export interface UnverifiedPoolPortion {
  /** Part of `applicable` that only exists because of unverified deposits. */
  amount: number;
  /** Contracts holding the unverified deposits, for the warning text. */
  contractNumbers: string[];
}

/**
 * Worst case: other contracts' requirements are met from verified money first,
 * so whatever of `applicable` is left over leans on the unverified deposits.
 */
export function unverifiedPortionOfApplicable(
  rows: PoolDepositContractRow[],
  applicable: number,
  otherRequired: number,
  // Paid top-ups join the pool as real, receipted money; committed adjustments
  // draw it down. Both are in get_deposit_available_balance's `available`.
  paidTopups = 0,
  committed = 0
): UnverifiedPoolPortion {
  const unverifiedRows = rows.filter((r) => isUnverifiedDeposit(r) && collected(r) > 0);
  const unverified = unverifiedRows.reduce((s, r) => s + collected(r), 0);
  const total = rows.reduce((s, r) => s + collected(r), 0);
  const verified = total - unverified + paidTopups - committed;

  const coveredByVerified = Math.max(verified - Math.max(otherRequired, 0), 0);
  const amount = Math.min(Math.max(applicable - coveredByVerified, 0), unverified);

  return {
    amount: Math.round(amount * 100) / 100,
    contractNumbers: amount > 0
      ? unverifiedRows.map((r) => r.contract_number).filter((n): n is string => !!n)
      : [],
  };
}
