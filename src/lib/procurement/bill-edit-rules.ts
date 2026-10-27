import { clampTolerancePercent, evaluateInvoiceTolerance, type ToleranceOutcome } from "@/lib/procurement/price-tolerance";

/** Roles that may correct any vendor bill (the bill's creator always may, whatever their role). */
export const BILL_EDIT_ROLES = ["admin", "manager", "office_admin"] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export function canEditBill(input: { role: string | null | undefined; userId: string | null | undefined; createdBy: string | null | undefined }): boolean {
  if (input.role && (BILL_EDIT_ROLES as readonly string[]).includes(input.role)) return true;
  return !!input.userId && !!input.createdBy && input.userId === input.createdBy;
}

export interface BillEditState {
  approvalStatus: string;
  /** Payments on the bill that have not been reversed. */
  standingPaymentCount: number;
  paymentStatus?: string | null;
  chequeSigned?: boolean;
}

/**
 * Why a bill can't be corrected right now, or null when it can. Corrections are
 * open from upload until the first payment lands; after that only the admin
 * Correct menu (reverse the payment first) can change it.
 */
export function billEditLockReason(state: BillEditState): string | null {
  if (state.approvalStatus === "withdrawn") {
    return "This bill was withdrawn and can no longer be changed. Upload a new bill if it is still needed.";
  }
  if (state.standingPaymentCount > 0 || (state.paymentStatus && state.paymentStatus !== "unpaid")) {
    return "A payment has been recorded on this bill, so it is locked. An admin can reverse the payment from the Correct menu if something is wrong.";
  }
  if (state.chequeSigned) {
    return "A cheque has already been signed for this bill. An admin must un-sign it from the Correct menu before the bill can be changed.";
  }
  return null;
}

export type AmountChange = "unchanged" | "lowered" | "raised";

export function classifyAmountChange(oldAmount: number, newAmount: number): AmountChange {
  const diff = round2(newAmount) - round2(oldAmount);
  if (Math.abs(diff) < 0.005) return "unchanged";
  return diff < 0 ? "lowered" : "raised";
}

/** What editing an amount does to an existing approval. Raised amounts go back to the approver. */
export function approvalAfterAmountChange(status: string, change: AmountChange): "keep" | "reset" {
  return status === "approved" && change === "raised" ? "reset" : "keep";
}

export interface CeilingInput {
  newTotal: number;
  isService: boolean;
  /** PO value (goods) or per-cycle cost (service). Null/0 = nothing to check against. */
  ceiling: number | null;
  /** Total of the PO's other live bills (goods POs only). */
  priorInvoiced: number;
  tolerancePercent: unknown;
  fullyReceived?: boolean;
}

export type CeilingResult =
  | { ok: true; outcome: ToleranceOutcome }
  | { ok: false; error: string };

/**
 * Same rule the bill is created under: firm PO = hard ceiling; flexible goods PO
 * lets the cumulative invoiced total drift inside the band. Unlike creation there
 * is no exception path here — outside the band the correction is refused.
 */
export function checkAmountAgainstCeiling(input: CeilingInput): CeilingResult {
  const { newTotal, isService, ceiling, priorInvoiced } = input;
  if (ceiling === null || !(ceiling > 0)) return { ok: true, outcome: { kind: "ok" } };

  const tolerance = isService ? 0 : clampTolerancePercent(input.tolerancePercent);
  const label = isService ? "cycle cost" : "PO value";

  if (tolerance === 0) {
    if (newTotal > ceiling + 0.01) {
      return { ok: false, error: `Corrected amount (${inr(newTotal)}) cannot exceed the ${label} (${inr(ceiling)}). Enter the pre-GST amount.` };
    }
    if (!isService && priorInvoiced + newTotal > ceiling + 0.01) {
      return {
        ok: false,
        error: `Other bills on this PO already total ${inr(priorInvoiced)} of ${inr(ceiling)}, so this one can be at most ${inr(Math.max(0, round2(ceiling - priorInvoiced)))}.`,
      };
    }
    return { ok: true, outcome: { kind: "ok" } };
  }

  const outcome = evaluateInvoiceTolerance({
    invoiceTotal: newTotal,
    base: ceiling,
    tolerancePercent: tolerance,
    priorInvoiced,
    fullyReceived: input.fullyReceived ?? true,
  });
  if (outcome.kind === "exception" && outcome.direction === "above") {
    return {
      ok: false,
      error: `Corrected amount would put this PO ${outcome.variancePercent}% above its value, outside the ±${tolerance}% allowance (up to ${inr(round2(ceiling * (1 + tolerance / 100)))} in total). Enter the pre-GST amount.`,
    };
  }
  return { ok: true, outcome };
}

/** Reasons Accounts can give when holding a bill's payment, for showing the hold on the procurement page. */
export const PAYMENT_HOLD_REASON_LABELS: Record<string, string> = {
  wrong_scan: "Wrong or unclear invoice scan",
  wrong_bank_details: "Bank details incorrect",
  bank_rejected: "Payment rejected by bank",
  amount_mismatch: "Amount doesn't match approved bill",
  duplicate_suspected: "Suspected duplicate payment",
  pending_docs: "Supporting documents missing",
  other: "Other reason",
};
