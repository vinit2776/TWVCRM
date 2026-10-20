/**
 * Completing a Virtual Office renewal once its statement is paid.
 *
 * Until this existed, only the Razorpay webhook renewed a case. A customer
 * who paid by bank transfer had the payment recorded by accounts, the
 * statement went to Paid, and the case stayed in renewal_due / grace_period
 * until the cron lapsed it. Every route that settles a statement now ends
 * here: the webhook directly, and recorded payments (including verified
 * "Report paid" claims) through finalizeBillingPayment.
 *
 * Kept out of vo-renewal.ts on purpose: that module pulls in the mailer,
 * WhatsApp and jsPDF, none of which the payment-settlement path should load.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import { nextRenewalTerm, statementCoversNextTerm } from "@/lib/vo-renewal-term";

export type RenewalCompletionOutcome =
  | "renewed"
  | "not_a_renewal"
  | "not_paid"
  | "already_renewed";

export async function completeVoRenewal(
  supabase: SupabaseClient,
  params: {
    statementId: string;
    /** User who recorded the payment; omit for the webhook. */
    performedBy?: string | null;
    /** How the payment arrived, for the audit trail. */
    source: "razorpay_link" | "recorded_payment";
  },
): Promise<RenewalCompletionOutcome> {
  const { statementId, performedBy = null, source } = params;

  const { data: stmt } = await supabase
    .from("billing_statements")
    .select("id, case_id, statement_type, period_start, payment_status, voided_at, fixed_amount")
    .eq("id", statementId)
    .maybeSingle();

  if (!stmt?.case_id || stmt.statement_type !== "vo_renewal" || stmt.voided_at) {
    return "not_a_renewal";
  }
  if (stmt.payment_status !== "paid") return "not_paid";

  const { data: caseRow } = await supabase
    .from("cases")
    .select("id, status, start_date, end_date, tenure_months, rate, aggregator_id, aggregator:aggregators!cases_aggregator_id_fkey(billing_method)")
    .eq("id", stmt.case_id)
    .maybeSingle();

  if (!caseRow?.end_date) return "not_a_renewal";

  const oldEnd = String(caseRow.end_date).slice(0, 10);
  if (!statementCoversNextTerm(stmt.period_start as string | null, oldEnd)) {
    // The case already moved past the term this statement paid for — a
    // replayed webhook, a second link paid for the same term, or a recorded
    // payment after the link already renewed it. Never roll twice.
    logAudit(supabase, {
      entityType: "case",
      entityId: caseRow.id as string,
      action: "update",
      performedBy: performedBy ?? "system",
      changes: {
        action: { old: null, new: "renewal_payment_ignored_already_renewed" },
        billing_statement_id: { old: null, new: statementId },
        source: { old: null, new: source },
      },
    });
    return "already_renewed";
  }

  const term = nextRenewalTerm(oldEnd, Number(caseRow.tenure_months) || 12);

  // The rate the next renewal escalates from is the fee this term was billed
  // at. Postpaid partner cases are billed monthly from `rate` and don't fit a
  // one-off renewal statement yet, so their rate is left alone.
  const aggregator = Array.isArray(caseRow.aggregator) ? caseRow.aggregator[0] : caseRow.aggregator;
  const isPostpaid = !!caseRow.aggregator_id && (aggregator as { billing_method?: string } | null)?.billing_method === "postpaid";
  const billedFee = Number(stmt.fixed_amount);
  const newRate = !isPostpaid && Number.isFinite(billedFee) && billedFee > 0 ? billedFee : null;

  const update: Record<string, unknown> = {
    status: "active",
    start_date: term.start,
    end_date: term.end,
    renewal_billing_statement_id: null,
    renewal_razorpay_link_id: null,
    renewal_razorpay_link_url: null,
    renewal_grace_ends_at: null,
    renewal_reminder_count: 0,
  };
  if (newRate !== null) update.rate = newRate;

  // Conditional on the end date we read, so two settlements racing each
  // other roll the case once.
  const { data: updated, error } = await supabase
    .from("cases")
    .update(update)
    .eq("id", caseRow.id)
    .eq("end_date", oldEnd)
    .select("id");

  if (error) throw new Error(`Failed to renew case ${caseRow.id}: ${error.message}`);
  if (!updated || updated.length === 0) return "already_renewed";

  logAudit(supabase, {
    entityType: "case",
    entityId: caseRow.id as string,
    action: "update",
    performedBy: performedBy ?? "system",
    changes: {
      action: { old: null, new: "renewal_payment_received" },
      source: { old: null, new: source },
      billing_statement_id: { old: null, new: statementId },
      status: { old: caseRow.status, new: "active" },
      start_date: { old: caseRow.start_date, new: term.start },
      end_date: { old: oldEnd, new: term.end },
      ...(newRate !== null && newRate !== Number(caseRow.rate)
        ? { rate: { old: caseRow.rate, new: newRate } }
        : {}),
    },
  });

  return "renewed";
}
