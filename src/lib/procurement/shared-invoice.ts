/**
 * Rules for one vendor invoice shared across several PO bills (migration 00671).
 * Pure functions only — the server helpers in shared-invoice-server.ts load the numbers.
 */

const TOL = 0.01;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** What "the same invoice number" means: case and spacing never make a different invoice. */
export function invoiceNumberKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

export interface AllocationSummary {
  allocated: number;
  left: number;
}

export function allocationSummary(invoiceTotal: number, shares: number[]): AllocationSummary {
  const allocated = round2(shares.reduce((s, n) => s + n, 0));
  return { allocated, left: round2(Math.max(0, invoiceTotal - allocated)) };
}

export type SharedInvoiceCode =
  | "TOTAL_CANNOT_DROP"
  | "OVER_ALLOCATED"
  | "TOTAL_OVER_PO_VALUE";

export type SharedInvoiceCheck =
  | { ok: true }
  | { ok: false; code: SharedInvoiceCode; message: string };

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export interface JoinInput {
  /** The invoice total on file before this change. */
  currentTotal: number;
  /** The total after this change (same as currentTotal unless the person raised it). */
  newTotal: number;
  /** Live shares already on the invoice, excluding the bill being added. */
  otherShares: number[];
  /** The share this bill takes. */
  share: number;
  /** Value of each distinct PO on the invoice, including this bill's PO. */
  poValues: number[];
}

/** Can this bill join (or open) the shared invoice with these numbers? */
export function checkJoin(input: JoinInput): SharedInvoiceCheck {
  const { currentTotal, newTotal, otherShares, share, poValues } = input;

  if (newTotal < currentTotal - TOL) {
    return {
      ok: false,
      code: "TOTAL_CANNOT_DROP",
      message: `The invoice total can only go up here (it is ${inr(currentTotal)} now). To lower it, ask an admin.`,
    };
  }

  const { allocated } = allocationSummary(newTotal, otherShares);
  if (allocated + share > newTotal + TOL) {
    const left = round2(Math.max(0, newTotal - allocated));
    return {
      ok: false,
      code: "OVER_ALLOCATED",
      message: `${inr(round2(allocated + share - newTotal))} more than is left on the invoice (${inr(left)} of ${inr(newTotal)}). Reduce the share, raise the invoice total if it is higher, or check this is the right invoice number.`,
    };
  }

  const gate = checkTotalAgainstPos(newTotal, poValues);
  if (gate) return { ok: false, code: "TOTAL_OVER_PO_VALUE", message: gate };
  return { ok: true };
}

/**
 * An invoice can't be worth more than the POs it covers together. Judged only once two
 * or more POs are on it: the first PO is uploaded before the others may exist, and its
 * share is already held to its own PO value.
 */
export function checkTotalAgainstPos(invoiceTotal: number, poValues: number[]): string | null {
  if (poValues.length < 2) return null;
  const combined = round2(poValues.reduce((s, n) => s + n, 0));
  if (invoiceTotal > combined + TOL) {
    return `The invoice total (${inr(invoiceTotal)}) is more than the combined value of its POs (${inr(combined)}).`;
  }
  return null;
}

export interface ApprovalGateInput {
  invoiceTotal: number;
  /** Live shares on the invoice, including the bill being approved. */
  shares: number[];
  /** Value of each distinct PO among the live bills. */
  poValues: number[];
}

/** Why a bill on a shared invoice can't be approved right now, or null when it can. */
export function sharedInvoiceApprovalError(input: ApprovalGateInput): string | null {
  const { allocated } = allocationSummary(input.invoiceTotal, input.shares);
  if (allocated > input.invoiceTotal + TOL) {
    return `The bills on this shared invoice add up to ${inr(allocated)}, more than the invoice total of ${inr(input.invoiceTotal)}. Correct the shares before approving.`;
  }
  const poGate = checkTotalAgainstPos(input.invoiceTotal, input.poValues);
  if (poGate) return `${poGate} Correct the invoice total or add the missing PO before approving.`;
  return null;
}
