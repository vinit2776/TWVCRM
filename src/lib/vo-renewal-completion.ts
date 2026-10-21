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
 * Each term is its own case: completion marks the paid-up case Renewed and
 * creates the next term's case (see vo-renewal-successor.ts), moving the
 * paid bill and carrying KYC over, instead of rolling the same case's dates.
 *
 * Kept out of vo-renewal.ts on purpose: that module pulls in the mailer,
 * WhatsApp and jsPDF, none of which the payment-settlement path should load.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import { nextRenewalTerm, statementCoversNextTerm, termMonthsFromPeriod } from "@/lib/vo-renewal-term";
import { carriedChildRow, successorCaseRow } from "@/lib/vo-renewal-successor";

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
    .select("id, case_id, statement_type, period_start, period_end, payment_status, voided_at, fixed_amount")
    .eq("id", statementId)
    .maybeSingle();

  if (!stmt?.case_id || stmt.statement_type !== "vo_renewal" || stmt.voided_at) {
    return "not_a_renewal";
  }
  if (stmt.payment_status !== "paid") return "not_paid";

  const { data: caseRow } = await supabase
    .from("cases")
    .select("*, aggregator:aggregators!cases_aggregator_id_fkey(billing_method)")
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

  // Start renewal can offer a different length than the current tenure; the
  // statement's period says which was billed. Older statements fall back to
  // the case's tenure.
  const currentTenure = Number(caseRow.tenure_months) || 12;
  const months = termMonthsFromPeriod(oldEnd, stmt.period_end as string | null) ?? currentTenure;
  const term = nextRenewalTerm(oldEnd, months);

  // The rate the next renewal escalates from is the fee this term was billed
  // at. Postpaid partner cases are billed monthly from `rate` and don't fit a
  // one-off renewal statement yet, so their rate is left alone.
  const aggregator = Array.isArray(caseRow.aggregator) ? caseRow.aggregator[0] : caseRow.aggregator;
  const isPostpaid = !!caseRow.aggregator_id && (aggregator as { billing_method?: string } | null)?.billing_method === "postpaid";
  const billedFee = Number(stmt.fixed_amount);
  const newRate = !isPostpaid && Number.isFinite(billedFee) && billedFee > 0 ? billedFee : null;

  // Each term is its own case. Claiming the current one as renewed first is
  // what makes this safe to run twice: two settlements racing each other,
  // or a replayed webhook, find it already renewed and stop.
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("cases")
    .update({ status: "renewed", renewed_at: now })
    .eq("id", caseRow.id)
    .neq("status", "renewed")
    .select("id");

  if (claimError) throw new Error(`Failed to renew case ${caseRow.id}: ${claimError.message}`);
  if (!claimed || claimed.length === 0) return "already_renewed";

  const { aggregator: _aggregator, ...previous } = caseRow as Record<string, unknown>;
  const { data: successor, error: insertError } = await supabase
    .from("cases")
    .insert(successorCaseRow(previous, { term, months, rate: newRate, statementId, performedBy, now }))
    .select("id, case_number")
    .single();

  if (insertError || !successor) {
    // Put the current term back so the payment can complete it on a retry.
    await supabase
      .from("cases")
      .update({ status: caseRow.status, renewed_at: caseRow.renewed_at ?? null })
      .eq("id", caseRow.id);
    throw new Error(`Failed to create the next term for case ${caseRow.id}: ${insertError?.message ?? "no row returned"}`);
  }
  const successorId = successor.id as string;

  // The paid bill is for the new term, so it belongs on the new case: its
  // Billing tab shows it as paid, and its agreement can execute against it.
  const { error: moveError } = await supabase
    .from("billing_statements")
    .update({ case_id: successorId })
    .eq("id", statementId);
  if (moveError) console.error(`[vo-renewal] could not move bill ${statementId} to case ${successorId}:`, moveError);

  // KYC and compliance carry over as they stood; documents are only asked for
  // again if staff change something on the new case.
  for (const table of ["case_documents", "case_compliance_checks"] as const) {
    const { data: rows, error: readError } = await supabase.from(table).select("*").eq("case_id", caseRow.id);
    if (readError) {
      console.error(`[vo-renewal] could not read ${table} for case ${caseRow.id}:`, readError);
      continue;
    }
    if (!rows || rows.length === 0) continue;
    const { error: copyError } = await supabase
      .from(table)
      .insert(rows.map((r) => carriedChildRow(r as Record<string, unknown>, successorId)));
    if (copyError) console.error(`[vo-renewal] could not carry ${table} to case ${successorId}:`, copyError);
  }

  logAudit(supabase, {
    entityType: "case",
    entityId: caseRow.id as string,
    action: "update",
    performedBy: performedBy ?? "system",
    changes: {
      action: { old: null, new: "renewal_payment_received" },
      source: { old: null, new: source },
      billing_statement_id: { old: null, new: statementId },
      status: { old: caseRow.status, new: "renewed" },
      renewed_to_case_id: { old: null, new: successorId },
    },
  });
  logAudit(supabase, {
    entityType: "case",
    entityId: successorId,
    action: "create",
    performedBy: performedBy ?? "system",
    changes: {
      action: { old: null, new: "renewal_term_created" },
      renewed_from_case_id: { old: null, new: caseRow.id },
      billing_statement_id: { old: null, new: statementId },
      start_date: { old: caseRow.start_date, new: term.start },
      end_date: { old: oldEnd, new: term.end },
      ...(months !== currentTenure ? { tenure_months: { old: currentTenure, new: months } } : {}),
      ...(newRate !== null && newRate !== Number(caseRow.rate)
        ? { rate: { old: caseRow.rate, new: newRate } }
        : {}),
    },
  });

  return "renewed";
}
