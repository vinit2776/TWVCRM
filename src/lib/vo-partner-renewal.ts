/**
 * Rolling a postpaid partner's Virtual Office case into its next term.
 *
 * A postpaid partner is billed monthly in arrears for all their cases, so a
 * partner case has no renewal bill and no payment link, and nothing to wait
 * for at the term boundary. What staff record instead is that the partner is
 * continuing (cases.metadata.partner_renewal: the term, the monthly rate and
 * how they confirmed). The next term starts only when that term's first day
 * arrives, because partner invoices choose cases by status and bill the
 * current rate for the month: rolling early would charge the new rate before
 * it applies.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { rollCaseToNextTerm } from "@/lib/vo-renewal-completion";
import { partnerRenewalIsCurrent, partnerRenewalRecord } from "@/lib/vo-renewal-reminders";
import { addMonthsEndAnchored } from "@/lib/vo-renewal-term";

export type PartnerRollOutcome =
  | { outcome: "renewed"; successorId: string }
  | { outcome: "already_renewed" }
  | { outcome: "not_ready" | "stale" | "no_confirmation" | "not_a_partner_case"; message: string };

const ROLLABLE_STATUSES = ["active", "renewal_due", "grace_period"];

export async function rollPartnerRenewal(
  supabase: SupabaseClient,
  params: { caseId: string; performedBy: string | null; today: string },
): Promise<PartnerRollOutcome> {
  const { caseId, performedBy, today } = params;

  const { data: caseRow } = await supabase
    .from("cases")
    .select("*, aggregator:aggregators!cases_aggregator_id_fkey(billing_method)")
    .eq("id", caseId)
    .maybeSingle();
  if (!caseRow?.end_date) {
    return { outcome: "not_a_partner_case", message: "This case has no end date, so there is no term to renew." };
  }
  if (caseRow.status === "renewed") return { outcome: "already_renewed" };

  const aggregator = Array.isArray(caseRow.aggregator) ? caseRow.aggregator[0] : caseRow.aggregator;
  const postpaid = !!caseRow.aggregator_id && (aggregator as { billing_method?: string } | null)?.billing_method === "postpaid";
  if (!postpaid) {
    return { outcome: "not_a_partner_case", message: "Only postpaid partner cases are rolled over without a bill." };
  }
  if (!ROLLABLE_STATUSES.includes(caseRow.status as string)) {
    return { outcome: "not_ready", message: `A ${String(caseRow.status).replace(/_/g, " ")} case can't be rolled over.` };
  }

  const rec = partnerRenewalRecord(caseRow.metadata);
  if (!rec) return { outcome: "no_confirmation", message: "No partner confirmation is recorded on this case." };

  const end = String(caseRow.end_date).slice(0, 10);
  if (!partnerRenewalIsCurrent(rec, end)) {
    return {
      outcome: "stale",
      message: "The case's end date changed after the partner was confirmed. Confirm again for the current term.",
    };
  }
  if (today < rec.term_start) {
    return { outcome: "not_ready", message: `The new term starts on ${rec.term_start}; it can be rolled over from then.` };
  }
  // The stored term must be a whole number of months from the current end, as the confirmation made it.
  if (addMonthsEndAnchored(end, rec.duration_months) !== rec.term_end) {
    return { outcome: "stale", message: "The confirmed term no longer matches the case. Confirm again." };
  }

  const { aggregator: _aggregator, ...previous } = caseRow as Record<string, unknown>;
  const outcome = await rollCaseToNextTerm(supabase, {
    caseRow: previous as Record<string, unknown> & { id: string; end_date: string; status: string },
    term: { start: rec.term_start, end: rec.term_end },
    months: rec.duration_months,
    rate: rec.new_rate,
    statementId: null,
    performedBy,
    auditAction: "partner_renewal_rolled",
    auditSource: "partner_confirmation",
    activatedAt: (caseRow.activated_at as string | null) ?? null,
    auditExtra: {
      confirmed_by: { old: null, new: rec.by_name ?? rec.by },
      confirmed_at: { old: null, new: rec.at },
      confirmation_note: { old: null, new: rec.note },
    },
  });
  if (outcome.outcome === "already_renewed") return { outcome: "already_renewed" };
  return { outcome: "renewed", successorId: outcome.successorId };
}
