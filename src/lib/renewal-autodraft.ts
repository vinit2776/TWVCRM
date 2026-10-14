/**
 * Which contracts the daily job should auto-draft a renewal for.
 * Pure so the window, the daily cap and the ordering can be unit-tested.
 */

/** Same window the Renew button and POST /renew enforce. */
export const AUTODRAFT_WINDOW_DAYS = 45;
/** Backlog guard: at most this many drafts per run, soonest-ending first. */
export const AUTODRAFT_DAILY_CAP = 5;
/** Days an auto-draft may sit unvalidated before staff are nudged once. */
export const VALIDATION_NUDGE_AFTER_DAYS = 7;

const DAY_MS = 86_400_000;

export interface AutodraftCandidate {
  id: string;
  end_date: string; // YYYY-MM-DD
  status: string;
  renewal_declined: boolean | null;
}

/** Whole days from todayIst (YYYY-MM-DD) to end_date. */
export function daysUntil(endDate: string, todayIst: string): number {
  return Math.round(
    (new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${todayIst}T00:00:00Z`).getTime()) / DAY_MS
  );
}

/**
 * Active, not-declined contracts inside the window that have no renewal yet,
 * soonest-ending first, capped. `alreadyRenewed` is the set of contract ids
 * that already have a non-terminated renewal.
 */
export function selectAutodraftTargets(
  contracts: AutodraftCandidate[],
  alreadyRenewed: Set<string>,
  todayIst: string,
  cap: number = AUTODRAFT_DAILY_CAP
): AutodraftCandidate[] {
  return contracts
    .filter((c) => c.status === "active" && !c.renewal_declined && !alreadyRenewed.has(c.id))
    .filter((c) => {
      const d = daysUntil(c.end_date, todayIst);
      return d >= 0 && d <= AUTODRAFT_WINDOW_DAYS;
    })
    .sort((a, b) => a.end_date.localeCompare(b.end_date))
    .slice(0, cap);
}

/** True when an unvalidated auto-draft is old enough to nudge, and hasn't been. */
export function needsValidationNudge(
  draft: { renewal_auto_created_at: string | null; renewal_validated_at: string | null; renewal_validation_nudged_at: string | null },
  now: Date
): boolean {
  if (!draft.renewal_auto_created_at || draft.renewal_validated_at || draft.renewal_validation_nudged_at) return false;
  return now.getTime() - new Date(draft.renewal_auto_created_at).getTime() >= VALIDATION_NUDGE_AFTER_DAYS * DAY_MS;
}

/**
 * An auto-created renewal draft cannot go to the customer (or be moved on
 * from draft) until a person has validated it. Returns the reason to refuse,
 * or null when the contract is free to proceed. Manual drafts are never gated.
 */
export function unvalidatedAutoDraftReason(contract: {
  is_renewal?: boolean | null;
  renewal_auto_created?: boolean | null;
  renewal_validated_at?: string | null;
}): string | null {
  if (contract.is_renewal && contract.renewal_auto_created && !contract.renewal_validated_at) {
    return "This renewal was created automatically. Check the rate, seats and dates and click Validate renewal before sending it to the customer.";
  }
  return null;
}
