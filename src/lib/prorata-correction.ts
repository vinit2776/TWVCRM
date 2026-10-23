const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ProrataAmounts {
  prorataDays: number;
  daysInMonth: number;
  subtotal: number;
  taxAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
}

/**
 * Pro-rata for the partial first month, using the same arithmetic as
 * POST /api/contracts/[id]/prorata-link so a corrected statement matches what
 * a fresh one would have been.
 */
export function computeProrataAmounts(params: {
  monthlySubtotal: number;
  startDate: string; // YYYY-MM-DD
  taxPercentage: number;
  isInterstate: boolean;
}): ProrataAmounts {
  const start = new Date(params.startDate + "T00:00:00Z");
  const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  const prorataDays = daysInMonth - start.getUTCDate() + 1;
  const subtotal = round2((params.monthlySubtotal / daysInMonth) * prorataDays);
  const taxAmount = round2(subtotal * (params.taxPercentage / 100));
  const half = round2(taxAmount / 2);
  return {
    prorataDays,
    daysInMonth,
    subtotal,
    taxAmount,
    cgstAmount: params.isInterstate ? 0 : half,
    sgstAmount: params.isInterstate ? 0 : round2(taxAmount - half),
    igstAmount: params.isInterstate ? taxAmount : 0,
    totalAmount: round2(subtotal + taxAmount),
  };
}

export interface CorrectionFacts {
  status: string;
  statementType: string | null;
  paymentStatus: string | null;
  paymentsCount: number;
  hasPaymentLink: boolean;
  gstInvoiceNumber: string | null;
  tallyInvoiceNumber: string | null;
  issuanceChannel: string | null;
  handoffState: string | null;
  liveUploadsCount: number;
  hasSingleProrataLine: boolean;
}

/**
 * A pro-rata statement can be amended in place only while nothing outside the
 * CRM depends on its amount: no payment, no payment link, no GST invoice
 * issued or uploaded, and accounts have not moved it past the request stage.
 * Returns a reason when it cannot, so the caller can say why.
 */
export function prorataCorrectionBlocker(f: CorrectionFacts): string | null {
  if (!["draft", "finalized"].includes(f.status)) return `The statement is ${f.status}.`;
  if (f.statementType !== "rent") return "Only a rent statement can be corrected this way.";
  if (!f.hasSingleProrataLine) return "The statement lines are not a single pro-rata line.";
  if ((f.paymentStatus ?? "unpaid") !== "unpaid" || f.paymentsCount > 0) return "A payment is already recorded against it.";
  if (f.hasPaymentLink) return "A payment link was already issued to the customer.";
  if (f.gstInvoiceNumber || f.tallyInvoiceNumber || f.issuanceChannel === "tally" || f.liveUploadsCount > 0) {
    return "A GST invoice has already been issued for it. Use a credit note and reissue instead.";
  }
  if (f.handoffState && f.handoffState !== "direct_gst_requested") {
    return `Accounts have already moved it to "${f.handoffState}".`;
  }
  return null;
}
