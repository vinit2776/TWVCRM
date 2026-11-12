/**
 * Wording of the security-deposit term on a proposal. DEFAULT_PROPOSAL_TERMS
 * used to hard-code "3 months" regardless of what was actually chosen.
 *
 * The line is no longer kept inside the editable terms text — it's generated
 * from the proposal's deposit fields alongside term/lock-in/notice (see
 * buildCommitmentTermLines in proposal-terms.ts).
 */

/** The standard deposit line, as written by the old static default and by earlier in-text syncing. */
export const STANDARD_DEPOSIT_LINE =
  /^(\s*(?:[•\-*]\s*)?)\d+(?:\.\d+)?\s+months?\s+rent\s+payable\s+as\s+an\s+interest\s+free\s+refundable\s+security\s+deposit(?:\s+of\s+Rs\.\s*[\d,]+(?:\.\d+)?)?\.?\s*$/i;

// "Rs." rather than "₹": the PDF's built-in font cannot print the rupee sign.
function formatRupees(amount: number): string {
  return `Rs. ${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function depositTermText(months: number, amount: number): string {
  const base = `${months} month${months === 1 ? "" : "s"} rent payable as an interest free refundable security deposit`;
  return amount > 0 ? `${base} of ${formatRupees(amount)}` : base;
}
