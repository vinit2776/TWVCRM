/**
 * Commitment terms (term, lock-in, notice period, security deposit) offered on
 * a proposal.
 *
 * These used to live only as static text inside DEFAULT_PROPOSAL_TERMS
 * ("Term 1 year (Lock-in 11 months)"), so the numbers the customer read could
 * silently disagree with what was actually negotiated. They are now captured
 * as proposal fields, and the matching T&C lines are generated from those
 * fields — shared by the proposal form preview, the detail page and the PDF so
 * all three always say the same thing.
 */

import { STANDARD_DEPOSIT_LINE, depositTermText } from "@/lib/proposal-deposit-terms";

export const PROPOSAL_MAX_TENURE_MONTHS = 18;

export interface ProposalCommitmentTerms {
  tenure_months?: number | null;
  lock_in_months?: number | null;
  notice_period_months?: number | null;
  security_deposit_months?: number | null;
  security_deposit_amount?: number | null;
}

/**
 * Upper bound for the notice period — same rule the contract forms use
 * (create-contract-dialog / contracts onboarding), so a proposal can never
 * offer a notice period the contract form wouldn't accept.
 */
export function maxNoticePeriodMonths(tenureMonths: number, lockInMonths: number): number {
  return Math.max(3, tenureMonths - lockInMonths);
}

/** Returns a user-facing error, or null when the combination is valid. */
export function validateCommitmentTerms(terms: ProposalCommitmentTerms): string | null {
  const { tenure_months: tenure, lock_in_months: lockIn, notice_period_months: notice } = terms;
  if (tenure == null) return "Choose the term offered to the customer";
  if (lockIn == null) return "Choose the lock-in period offered to the customer";
  if (notice == null) return "Choose the notice period offered to the customer";
  if (tenure < 1 || tenure > PROPOSAL_MAX_TENURE_MONTHS) {
    return `Term must be between 1 and ${PROPOSAL_MAX_TENURE_MONTHS} months`;
  }
  if (lockIn < 1 || lockIn > tenure) {
    return `Lock-in must be between 1 month and the term (${tenure} months)`;
  }
  const maxNotice = maxNoticePeriodMonths(tenure, lockIn);
  if (notice < 0 || notice > maxNotice) {
    return `Notice period must be between 0 and ${maxNotice} months`;
  }
  return null;
}

/** True once the proposal carries structured commitment terms (legacy proposals don't). */
export function hasCommitmentTerms(terms: ProposalCommitmentTerms): boolean {
  return terms.tenure_months != null && terms.lock_in_months != null && terms.notice_period_months != null;
}

function months(n: number): string {
  return `${n} month${n === 1 ? "" : "s"}`;
}

/**
 * The T&C bullet lines generated from the commitment fields. Empty for legacy
 * proposals without structured terms — their stored terms_and_conditions text
 * already contains whatever was sent to the customer and must stay untouched.
 */
export function buildCommitmentTermLines(terms: ProposalCommitmentTerms): string[] {
  if (!hasCommitmentTerms(terms)) return [];
  const deposit = Number(terms.security_deposit_months || 0);
  const notice = terms.notice_period_months as number;
  return [
    deposit > 0
      ? `• ${depositTermText(deposit, Number(terms.security_deposit_amount || 0))}`
      : "• No security deposit",
    `• Term ${months(terms.tenure_months as number)} (Lock-in ${months(terms.lock_in_months as number)})`,
    notice > 0 ? `• Notice period ${months(notice)} post lock-in` : "• No notice period post lock-in",
  ];
}

/**
 * Full T&C as the customer sees it: generated lines first, then the free-text
 * terms. Once structured terms exist, the old standard deposit/term/notice
 * lines are dropped from the free text — a legacy proposal whose agreed terms
 * were recorded later would otherwise print both versions side by side.
 */
export function composeProposalTerms(
  terms: ProposalCommitmentTerms & { terms_and_conditions?: string | null }
): string {
  const generated = buildCommitmentTermLines(terms);
  const freeText = terms.terms_and_conditions?.trim() ?? "";
  return [...generated, generated.length > 0 ? stripLegacyCommitmentLines(freeText).trim() : freeText]
    .filter(Boolean)
    .join("\n");
}

// The three lines the old static DEFAULT_PROPOSAL_TERMS carried (the deposit
// one possibly with an amount, from the earlier in-text syncing). Stripped from
// a legacy draft's free text when it is edited, so the regenerated lines don't
// sit next to a contradicting copy.
const LEGACY_STATIC_LINE_PATTERNS = [
  STANDARD_DEPOSIT_LINE,
  /^•?\s*Term\b.*\(Lock-in\b.*\)\.?$/i,
  /^•?\s*Notice period\b.*post lock-in\.?$/i,
];

export function stripLegacyCommitmentLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !LEGACY_STATIC_LINE_PATTERNS.some((re) => re.test(line.trim())))
    .join("\n");
}

/** Free text still mentioning these terms would contradict the generated lines. */
export function mentionsCommitmentTerms(text: string): boolean {
  return /lock-?in|notice period|security deposit/i.test(text);
}
