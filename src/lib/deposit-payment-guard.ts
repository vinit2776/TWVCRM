/**
 * Guard against settling an invoice against a customer's security deposit
 * outside the deposit-adjustment flow.
 *
 * Why: "Adjustment against deposit" is maker-checker (an admin/manager approves,
 * then the deposit balance drops). Recording the same thing as a plain payment
 * ("Other", with a narration like "adjusted against deposit") settles the invoice
 * but never touches the deposit and skips the approval. That happened on
 * TWV-C-0078 (BS-0068 / BS-0144) and was corrected by hand on 2026-10-08.
 *
 * The rule is structural, not keyword-driven: while the customer has deposit
 * available, "Other" is never a plain payment mode. Keyword matching only widens
 * it to real bank modes whose own narration says it is a deposit adjustment.
 * A genuine receipt can still be recorded with an explicit written reason, which
 * the caller writes to the audit log.
 */

export const DEPOSIT_ADJUSTMENT_MODE = "deposit_adjustment";
export const DEPOSIT_OVERRIDE_MIN_REASON_LENGTH = 15;
/** Prefix written into payment notes when an operator overrides the guard; the review report skips these. */
export const DEPOSIT_OVERRIDE_NOTE_MARKER = "[Not a deposit adjustment";

// Stems, not words, so "Adjusted Deposit", "ADJUSTED SECURITY DEPOSIT" and
// "Deposit adj." all match. Devanagari: adjust / security / deposit-ish.
const DEPOSIT_WORDING =
  /depos|security\s*dep|\badj(?:ust)?|एडजस्ट|सिक्योरिटी|डिपॉज़िट|डिपोजिट|जमा/;

function normalise(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ");
}

export function mentionsDeposit(...texts: Array<string | null | undefined>): boolean {
  return DEPOSIT_WORDING.test(normalise(texts.filter(Boolean).join(" ")));
}

export type DepositGuardResult =
  | { ok: true; overridden: boolean }
  | { ok: false; code: "DEPOSIT_AVAILABLE" | "OVERRIDE_REASON_TOO_SHORT"; message: string };

export function evaluateDepositGuard(input: {
  mode: string;
  reference?: string | null;
  notes?: string | null;
  /** null = balance lookup failed or the statement has no contract: fail open. */
  depositAvailable: number | null;
  overrideReason?: string | null;
}): DepositGuardResult {
  const { mode, reference, notes, depositAvailable, overrideReason } = input;

  if (mode === DEPOSIT_ADJUSTMENT_MODE) return { ok: true, overridden: false };
  if (depositAvailable === null || depositAvailable <= 0) return { ok: true, overridden: false };

  const suspicious = mode === "other" || mentionsDeposit(reference, notes);
  if (!suspicious) return { ok: true, overridden: false };

  const reason = (overrideReason ?? "").trim();
  if (reason.length >= DEPOSIT_OVERRIDE_MIN_REASON_LENGTH) return { ok: true, overridden: true };
  if (reason.length > 0) {
    return {
      ok: false,
      code: "OVERRIDE_REASON_TOO_SHORT",
      message: `Give a reason of at least ${DEPOSIT_OVERRIDE_MIN_REASON_LENGTH} characters.`,
    };
  }

  const amount = depositAvailable.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return {
    ok: false,
    code: "DEPOSIT_AVAILABLE",
    message:
      `This customer has ₹${amount} of deposit available, and this payment looks like a deposit ` +
      `adjustment. Use "Adjustment against deposit" instead so the balance updates and an admin or ` +
      `manager approves it. If it's a genuine receipt, confirm it with a reason.`,
  };
}
