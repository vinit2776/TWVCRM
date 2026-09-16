/**
 * Keeps the security-deposit line in a proposal's Terms & Conditions in step
 * with the deposit selected on the form. DEFAULT_PROPOSAL_TERMS used to hard-code
 * "3 months" regardless of what was actually chosen.
 *
 * Only a line we recognise as the standard deposit wording is rewritten or
 * removed. If someone has reworded it (any other line mentioning "security
 * deposit"), their text is left alone and nothing is inserted alongside it.
 */

const STANDARD_DEPOSIT_LINE =
  /^(\s*(?:[•\-*]\s*)?)\d+\s+months?\s+rent\s+payable\s+as\s+an\s+interest\s+free\s+refundable\s+security\s+deposit(?:\s+of\s+Rs\.\s*[\d,]+(?:\.\d+)?)?\.?\s*$/i;
const BULLET_PREFIX = /^(\s*(?:[•\-*]\s*)?)/;

// "Rs." rather than "₹": the PDF's built-in font cannot print the rupee sign.
function formatRupees(amount: number): string {
  return `Rs. ${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function depositTermText(months: number, amount: number): string {
  return `${months} month${months === 1 ? "" : "s"} rent payable as an interest free refundable security deposit of ${formatRupees(amount)}`;
}

export function syncDepositTerm(terms: string, months: number, amount: number): string {
  const lines = terms.split("\n");
  const index = lines.findIndex((line) => STANDARD_DEPOSIT_LINE.test(line));

  if (months <= 0) {
    if (index === -1) return terms;
    lines.splice(index, 1);
    return lines.join("\n");
  }

  const text = depositTermText(months, amount);

  if (index !== -1) {
    const prefix = lines[index].match(STANDARD_DEPOSIT_LINE)?.[1] ?? "";
    lines[index] = `${prefix}${text}`;
    return lines.join("\n");
  }

  if (/security\s+deposit/i.test(terms)) return terms;

  if (!terms.trim()) return `• ${text}`;

  const taxesIndex = lines.findIndex((line) => /taxes\s+as\s+applicable/i.test(line));
  const insertAt = taxesIndex === -1 ? 0 : taxesIndex + 1;
  const neighbour = lines[taxesIndex === -1 ? 0 : taxesIndex];
  const prefix = neighbour.match(BULLET_PREFIX)?.[1] || "• ";
  lines.splice(insertAt, 0, `${prefix}${text}`);
  return lines.join("\n");
}
