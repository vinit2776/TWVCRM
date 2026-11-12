/**
 * Carries the commitment terms agreed on a proposal (term, lock-in, notice
 * period) into the contract created from it.
 *
 * The contract forms prefill and lock these from the proposal; this module is
 * the server-side gate that makes the lock real — shared by POST
 * /api/contracts and PATCH /api/contracts/[id]. Only an admin may issue a
 * contract whose terms differ from the proposal, and only with a reason.
 */

import {
  hasCommitmentTerms,
  validateCommitmentTerms,
  type ProposalCommitmentTerms,
} from "@/lib/proposal-terms";

export const COMMITMENT_OVERRIDE_MIN_REASON_LENGTH = 10;

/** Roles allowed to record agreed terms on an accepted proposal that predates them. */
export const RECORD_COMMITMENT_TERMS_ROLES = ["admin", "manager", "sales_rep"] as const;

export interface CommitmentValues {
  tenure_months: number;
  lock_in_months: number;
  notice_period_months: number;
}

export type CommitmentResolution =
  | { ok: true; values: CommitmentValues; overridden: boolean }
  | { ok: false; status: 400 | 403; error: string };

const FIELDS = ["tenure_months", "lock_in_months", "notice_period_months"] as const;
const LABELS: Record<(typeof FIELDS)[number], string> = {
  tenure_months: "term",
  lock_in_months: "lock-in",
  notice_period_months: "notice period",
};

function months(n: number): string {
  return `${n} month${n === 1 ? "" : "s"}`;
}

export function describeCommitment(v: CommitmentValues): string {
  return `term ${months(v.tenure_months)}, lock-in ${months(v.lock_in_months)}, notice ${months(v.notice_period_months)}`;
}

/** Which of the three terms differ, e.g. ["lock-in 11 → 9 months"]. */
export function commitmentDifferences(agreed: CommitmentValues, actual: CommitmentValues): string[] {
  return FIELDS.filter((f) => agreed[f] !== actual[f]).map(
    (f) => `${LABELS[f]} ${agreed[f]} → ${months(actual[f])}`
  );
}

export function resolveContractCommitment(input: {
  proposal: ProposalCommitmentTerms & { proposal_number?: string | null };
  submitted: Partial<CommitmentValues>;
  overrideReason?: string | null;
  isAdmin: boolean;
}): CommitmentResolution {
  const { proposal, submitted, isAdmin } = input;
  const ref = proposal.proposal_number || "The linked proposal";

  if (!hasCommitmentTerms(proposal)) {
    return {
      ok: false,
      status: 400,
      error: `${ref} has no agreed term, lock-in or notice period recorded. Record the agreed terms on the proposal before creating a contract.`,
    };
  }

  const agreed: CommitmentValues = {
    tenure_months: proposal.tenure_months as number,
    lock_in_months: proposal.lock_in_months as number,
    notice_period_months: proposal.notice_period_months as number,
  };
  const actual: CommitmentValues = {
    tenure_months: submitted.tenure_months ?? agreed.tenure_months,
    lock_in_months: submitted.lock_in_months ?? agreed.lock_in_months,
    notice_period_months: submitted.notice_period_months ?? agreed.notice_period_months,
  };

  const differences = commitmentDifferences(agreed, actual);
  if (differences.length === 0) return { ok: true, values: agreed, overridden: false };

  const reason = input.overrideReason?.trim() ?? "";
  if (!reason) {
    return {
      ok: false,
      status: 400,
      error: `Terms must match ${ref} (${describeCommitment(agreed)}). Differs: ${differences.join(", ")}. Only an admin can override, with a reason.`,
    };
  }
  if (!isAdmin) {
    return { ok: false, status: 403, error: "Only an admin can override the terms agreed on the proposal." };
  }
  if (reason.length < COMMITMENT_OVERRIDE_MIN_REASON_LENGTH) {
    return { ok: false, status: 400, error: "Give a fuller reason for overriding the agreed terms." };
  }
  const invalid = validateCommitmentTerms(actual);
  if (invalid) return { ok: false, status: 400, error: invalid };

  return { ok: true, values: actual, overridden: true };
}

/**
 * Inclusive end date for a term starting on startYmd: a contract starting
 * 1 Oct for 12 months ends 30 Sep. Pure UTC date math so client and server agree.
 */
export function commitmentEndDate(startYmd: string, tenureMonths: number): string {
  const d = new Date(`${startYmd}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + tenureMonths);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
