import { PRICE_TOLERANCE_MAX_PERCENT } from "@/lib/constants";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function clampTolerancePercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), PRICE_TOLERANCE_MAX_PERCENT);
}

export type ToleranceOutcome =
  /** Tolerance not in play (firm PO) or the invoice sits inside the PO value. */
  | { kind: "ok" }
  /** Over the PO value but inside the allowance — normal approval path. */
  | { kind: "within"; varianceAmount: number; variancePercent: number }
  /** Outside the allowance — flagged, needs an explanation and an admin acknowledgement. */
  | { kind: "exception"; direction: "above" | "below"; varianceAmount: number; variancePercent: number };

export interface ToleranceInput {
  /** This invoice's total. */
  invoiceTotal: number;
  /** What the invoices are measured against: the PO value, or the value of goods received if short-delivered. */
  base: number;
  tolerancePercent: number;
  /** Total of the PO's other live (non-rejected) bills. */
  priorInvoiced: number;
  /** All ordered goods have been received. */
  fullyReceived: boolean;
}

/**
 * Judges an invoice against a PO's price tolerance. Cumulative on the high side
 * (several bills together can't sneak past the allowance); the low side is only
 * judged when this is the PO's only invoice and everything was delivered —
 * otherwise a normal partial invoice would look like an under-bill.
 */
export function evaluateInvoiceTolerance(input: ToleranceInput): ToleranceOutcome {
  const { invoiceTotal, base, tolerancePercent, priorInvoiced, fullyReceived } = input;
  if (tolerancePercent <= 0 || base <= 0) return { kind: "ok" };

  const cumulative = priorInvoiced + invoiceTotal;
  const upper = base * (1 + tolerancePercent / 100);

  if (cumulative > base + 0.01) {
    const varianceAmount = round2(cumulative - base);
    const variancePercent = round2((varianceAmount / base) * 100);
    return cumulative > upper + 0.01
      ? { kind: "exception", direction: "above", varianceAmount, variancePercent }
      : { kind: "within", varianceAmount, variancePercent };
  }

  const lower = base * (1 - tolerancePercent / 100);
  if (fullyReceived && priorInvoiced <= 0.01 && invoiceTotal < lower - 0.01) {
    const varianceAmount = round2(invoiceTotal - base);
    return { kind: "exception", direction: "below", varianceAmount, variancePercent: round2((varianceAmount / base) * 100) };
  }
  return { kind: "ok" };
}
