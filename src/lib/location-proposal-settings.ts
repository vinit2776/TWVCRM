/**
 * Per-location proposal defaults. A new proposal starts from its location's
 * terms and commitment numbers; the proposal then keeps its own snapshot, so
 * changing these never alters a proposal that already exists.
 */

import { z } from "zod";
import { PROPOSAL_MAX_TENURE_MONTHS, PROPOSAL_MAX_NOTICE_MONTHS, maxNoticePeriodMonths } from "@/lib/proposal-terms";

export const PROPOSAL_SETTINGS_EDITOR_ROLES = ["admin", "manager", "sales_rep"] as const;
export const canEditProposalSettings = (role: string | null | undefined): boolean =>
  (PROPOSAL_SETTINGS_EDITOR_ROLES as readonly string[]).includes(role ?? "");

export const MAX_PROPOSAL_TERMS_LENGTH = 8000;
export const MAX_SECURITY_DEPOSIT_MONTHS = 12;
export const MAX_VALID_DAYS = 365;

const optionalInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();

export const proposalDefaultsSchema = z
  .object({
    tenure_months: optionalInt(1, PROPOSAL_MAX_TENURE_MONTHS),
    lock_in_months: optionalInt(1, PROPOSAL_MAX_TENURE_MONTHS),
    notice_period_months: optionalInt(0, PROPOSAL_MAX_NOTICE_MONTHS),
    security_deposit_months: optionalInt(0, MAX_SECURITY_DEPOSIT_MONTHS),
    valid_days: optionalInt(1, MAX_VALID_DAYS),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.tenure_months != null && d.lock_in_months != null && d.lock_in_months > d.tenure_months) {
      ctx.addIssue({ code: "custom", message: "Lock-in cannot be longer than the term" });
    }
    if (
      d.tenure_months != null && d.lock_in_months != null && d.notice_period_months != null &&
      d.notice_period_months > maxNoticePeriodMonths(d.tenure_months, d.lock_in_months)
    ) {
      ctx.addIssue({ code: "custom", message: "Notice period is longer than the term allows" });
    }
  });

export type ProposalDefaults = z.infer<typeof proposalDefaultsSchema>;

/** Drops unset fields; an all-empty object becomes null (back to "no defaults"). */
export function cleanProposalDefaults(d: ProposalDefaults): ProposalDefaults | null {
  const entries = Object.entries(d).filter(([, v]) => v != null);
  return entries.length ? (Object.fromEntries(entries) as ProposalDefaults) : null;
}

/** The terms text a new proposal for the location starts from. */
export function resolveProposalTerms(locationTerms: string | null | undefined, fallback: string): string {
  return locationTerms?.trim() ? locationTerms : fallback;
}

/** valid_until (YYYY-MM-DD) for a proposal created today with the given validity. */
export function validUntilFromDays(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
