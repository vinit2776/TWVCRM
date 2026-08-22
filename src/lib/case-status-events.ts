/**
 * Event-derived Virtual Office case status.
 *
 * cases.status used to be advanced by hand via "Change Status". In practice
 * nobody did: an audit on 22 Aug 2026 found all 58 production cases in the
 * first three states, 13 of 16 states never used, and the renewal cron —
 * which selects on status = 'active' — silently inert since it shipped.
 *
 * So the pipeline is derived from events the system already handles. Each
 * helper below is called next to the write that represents the event, and is
 * deliberately fire-and-forget: a case's displayed stage must never be able
 * to fail the operation that produced it (same contract as logAudit).
 *
 * Stages only ever move forward here. A case that is already past the stage
 * being reported is left alone, so an out-of-order or replayed event cannot
 * drag a live case backwards. Corrections are the job of the admin-only
 * "Change Status" override, which validates against CASE_STATUS_TRANSITIONS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTimestampField } from "@/lib/case-workflow";

/** Forward-only ordering. Retired hand-off states map onto the stage they
 *  correspond to so a legacy case is never treated as ahead of where it is. */
const RANK: Record<string, number> = {
  intake_received: 0,
  docs_requested: 0,
  docs_received: 1,
  under_review: 1,
  compliance_check: 1,
  internal_approved: 2,
  sent_for_client_approval: 2,
  client_approved: 2,
  signing_in_progress: 2,
  invoiced: 3,
  paid: 4,
  executed: 4,
  active: 5,
  renewal_due: 6,
  grace_period: 6,
  renewed: 6,
  lapsed: 7,
};

export type DerivedCaseStage =
  | "docs_received"
  | "internal_approved"
  | "invoiced"
  | "paid"
  | "active";

/**
 * Advances a case to `stage` if it isn't already at or past it.
 * Never throws — failures are logged and swallowed.
 */
export async function advanceCaseStage(
  supabase: SupabaseClient,
  caseId: string,
  stage: DerivedCaseStage,
): Promise<void> {
  try {
    const { data: row } = await supabase
      .from("cases")
      .select("status")
      .eq("id", caseId)
      .maybeSingle();

    if (!row) return;

    const current = RANK[row.status as string] ?? 0;
    const target = RANK[stage] ?? 0;
    if (current >= target) return;

    const update: Record<string, unknown> = { status: stage };
    const timestampField = getTimestampField(stage);
    if (timestampField) update[timestampField] = new Date().toISOString();

    const { error } = await supabase.from("cases").update(update).eq("id", caseId);
    if (error) {
      console.error(`[case-status] failed to advance case ${caseId} to ${stage}: ${error.message}`);
    }
  } catch (err) {
    console.error(`[case-status] failed to advance case ${caseId} to ${stage}:`, err);
  }
}

/**
 * The Leave & License agreement executing is what makes a case live — but
 * only once it is actually paid for. checkVoExecutionPaymentGate already
 * blocks execution before payment for direct clients and prepaid
 * aggregators; this re-checks rather than assuming, so a case cannot go
 * active on an unpaid invoice if that gate is ever bypassed or changed.
 * Postpaid aggregators are billed monthly in arrears, so execution alone
 * activates them.
 */
export async function advanceCaseOnAgreementExecuted(
  supabase: SupabaseClient,
  caseId: string,
): Promise<void> {
  try {
    const { data: caseRow } = await supabase
      .from("cases")
      .select("aggregator_id, aggregator:aggregators!cases_aggregator_id_fkey(billing_method)")
      .eq("id", caseId)
      .maybeSingle();

    if (!caseRow) return;

    const aggregator = caseRow.aggregator as unknown as { billing_method?: string } | null;
    const isPostpaid = !!caseRow.aggregator_id && aggregator?.billing_method === "postpaid";

    if (!isPostpaid) {
      const { data: statement } = await supabase
        .from("billing_statements")
        .select("payment_status")
        .eq("case_id", caseId)
        .eq("statement_type", "vo_case")
        .is("voided_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      // Executed but not yet paid: hold at 'paid'-minus — leave the case
      // wherever it is rather than claiming it is live.
      if (statement?.payment_status !== "paid") return;
    }

    await advanceCaseStage(supabase, caseId, "active");
  } catch (err) {
    console.error(`[case-status] failed to evaluate activation for case ${caseId}:`, err);
  }
}
