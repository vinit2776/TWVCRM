/**
 * Canonical Virtual Office term-fee rule (owner-confirmed).
 *
 * cases.rate is the fee for the whole term when tenure_months is 12 or less
 * (11 or 12), and the ANNUAL rate when the term is longer (24, 36, 48). Every
 * place that needs "what does this whole term cost" or "what rate do we store
 * for a term billed at this fee" goes through these two functions.
 */

const roundRupee = (n: number): number => Math.round(n);

/**
 * Fee for the whole term. Terms of 12 months or less return the rate as stored; longer terms are
 * scaled from the annual rate and rounded to the nearest rupee (owner decision). Unknown tenure is
 * treated as <= 12 (rate is the fee).
 */
export function termFee(rate: number | null | undefined, tenureMonths: number | null | undefined): number {
  const r = Number(rate) || 0;
  const months = Number(tenureMonths) || 0;
  return months > 12 ? roundRupee((r * months) / 12) : r;
}

/**
 * Inverse of termFee: the value to store in cases.rate for a term billed at
 * `fee`. The fee itself for terms of 12 months or less, the annual rate
 * (fee x 12 / months, nearest rupee) for longer ones.
 */
export function annualRateFor(fee: number | null | undefined, tenureMonths: number | null | undefined): number {
  const f = Number(fee) || 0;
  const months = Number(tenureMonths) || 0;
  return months > 12 ? roundRupee((f * 12) / months) : f;
}
