/**
 * Building the case for a Virtual Office case's next term.
 *
 * A paid renewal no longer rolls the dates of the same case forward: each
 * term is its own case, so its dates, rate, agreement and invoices stay with
 * that term. The new case is a light copy of the one it renews, starting
 * live: same client, purpose, location and payer, with KYC carried over.
 */

/** A case row as read with select("*"). */
export type CaseRow = Record<string, unknown>;

/**
 * Columns that belong to the term being renewed and must not be carried into
 * the next one. Everything else is copied, so a column added to `cases` later
 * follows the client by default.
 */
const TERM_ONLY_COLUMNS = [
  "id",
  "case_number", // left null so the trigger numbers the new case
  "created_at",
  "updated_at",
  "created_by",
  "status",
  "is_renewal",
  "parent_case_id",
  "start_date",
  "end_date",
  "rate",
  "tenure_months",
  "metadata",
  // The previous term's agreements stay on its case.
  "agreement_id",
  "ll_agreement_id",
  "ll_agreement_status",
  // Inbound email is matched to a case by thread; one thread, one case.
  "source_email_id",
  "email_thread_id",
  // Steps the previous term went through that the new one doesn't repeat.
  "sent_for_client_approval_at",
  "client_approved_at",
  "signing_started_at",
  "executed_at",
  "invoiced_at",
  "activated_at",
  "renewal_due_at",
  "renewed_at",
  "lapsed_at",
  // The renewal cycle restarts on the new term.
  "renewal_billing_statement_id",
  "renewal_razorpay_link_id",
  "renewal_razorpay_link_url",
  "renewal_grace_ends_at",
  "renewal_reminder_count",
  "renewal_last_reminder_at",
] as const;

export function successorCaseRow(
  previous: CaseRow,
  params: {
    term: { start: string; end: string };
    months: number;
    rate: number | null;
    statementId: string;
    performedBy: string | null;
    now: string;
  },
): CaseRow {
  const row: CaseRow = { ...previous };
  for (const column of TERM_ONLY_COLUMNS) delete row[column];

  const previousMetadata =
    previous.metadata && typeof previous.metadata === "object" && !Array.isArray(previous.metadata)
      ? (previous.metadata as Record<string, unknown>)
      : {};

  return {
    ...row,
    status: "active",
    activated_at: params.now,
    is_renewal: true,
    // One level deep: every term points at the first case, which is how the
    // subscription history finds them all.
    parent_case_id: (previous.parent_case_id as string | null) ?? previous.id,
    start_date: params.term.start,
    end_date: params.term.end,
    tenure_months: params.months,
    rate: params.rate ?? previous.rate ?? null,
    created_by: params.performedBy ?? previous.created_by ?? null,
    metadata: {
      ...previousMetadata,
      renewed_from_case_id: previous.id,
      renewal_billing_statement_id: params.statementId,
    },
  };
}

/** A case_documents or case_compliance_checks row copied onto the new case. */
export function carriedChildRow(row: Record<string, unknown>, caseId: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...row, case_id: caseId };
  delete copy.id;
  delete copy.created_at;
  delete copy.updated_at;
  return copy;
}
