import type { SupabaseClient } from "@supabase/supabase-js";
import { balanceDue, paymentCredit } from "@/lib/settlement";
import type { PaymentReportEntityType } from "./payment-reports";

/**
 * How much of a transaction is still legitimately reportable.
 *
 * Without this, nothing stopped the same money being reported twice. The
 * dialog happily reopened on a proposal whose full deposit was already
 * reported and pending, and two identical claims would produce two threads,
 * two chases, and two chances for accounts to record the same payment.
 *
 * "Reportable" is the outstanding amount minus what is already claimed and
 * awaiting verification. Rejected reports free their amount back up (the
 * claim was found not to exist); verified ones don't need to, because
 * verifying records a real payment and the outstanding figure drops on its
 * own.
 */

/** Rupee tolerance — statement totals round, and a claim shouldn't fail by paise. */
export const REPORT_TOLERANCE = 1;

interface EmbeddedQuery {
  entity_type: string;
  entity_id: string;
}

export interface ReportableBalance {
  /** Still owed on the transaction itself. */
  outstanding: number;
  /** Already claimed and awaiting verification. */
  pending: number;
  /** outstanding - pending, floored at 0. */
  reportable: number;
}

async function statementOutstanding(admin: SupabaseClient, statementId: string): Promise<number> {
  const { data: stmt } = await admin
    .from("billing_statements").select("id, total_amount").eq("id", statementId).maybeSingle();
  if (!stmt) return 0;
  const { data: payments } = await admin
    .from("billing_payments").select("amount, tds_amount").eq("billing_statement_id", statementId);
  const paid = (payments ?? []).reduce(
    (sum, p) => sum + paymentCredit(p as { amount: number; tds_amount: number | null }),
    0,
  );
  return Math.max(0, balanceDue(stmt.total_amount as number, paid));
}

async function contractOutstanding(admin: SupabaseClient, contractId: string): Promise<number> {
  const { data: stmts } = await admin
    .from("billing_statements")
    .select("id, total_amount")
    .eq("contract_id", contractId)
    .in("status", ["finalized", "exported"])
    .in("payment_status", ["unpaid", "partially_paid"])
    .is("voided_at", null);

  const ids = (stmts ?? []).map((s) => s.id as string);
  if (ids.length === 0) return 0;

  const { data: payments } = await admin
    .from("billing_payments").select("billing_statement_id, amount, tds_amount").in("billing_statement_id", ids);

  const paidBy = new Map<string, number>();
  for (const p of payments ?? []) {
    const row = p as { billing_statement_id: string; amount: number; tds_amount: number | null };
    paidBy.set(row.billing_statement_id, (paidBy.get(row.billing_statement_id) ?? 0) + paymentCredit(row));
  }
  return (stmts ?? []).reduce(
    (sum, s) => sum + Math.max(0, balanceDue(s.total_amount as number, paidBy.get(s.id as string) ?? 0)),
    0,
  );
}

async function depositOutstanding(admin: SupabaseClient, proposalId: string): Promise<number> {
  const { data: p } = await admin
    .from("proposals")
    .select("security_deposit_amount, deposit_credit_amount, deposit_exception_amount, deposit_payment_amount, deposit_payment_status")
    .eq("id", proposalId)
    .maybeSingle();
  if (!p) return 0;
  // Already settled — nothing left to claim.
  if (p.deposit_payment_status === "paid" || p.deposit_payment_status === "not_required") return 0;
  // Same arithmetic the manual-record dialog uses to prefill the expected
  // figure, so the two can't disagree about what is owed.
  const required =
    Number(p.security_deposit_amount || 0) +
    Number(p.deposit_exception_amount || 0) -
    Number(p.deposit_credit_amount || 0);
  return Math.max(0, required - Number(p.deposit_payment_amount || 0));
}

async function topupOutstanding(admin: SupabaseClient, topupId: string): Promise<number> {
  const { data: t } = await admin
    .from("deposit_topups")
    .select("amount, status")
    .eq("id", topupId)
    .maybeSingle();
  if (!t) return 0;
  // Already settled, or withdrawn — nothing left to claim.
  if (t.status !== "pending") return 0;
  return Math.max(0, Number(t.amount || 0));
}

export async function reportableBalance(
  admin: SupabaseClient,
  entityType: PaymentReportEntityType,
  entityId: string,
): Promise<ReportableBalance> {
  const outstanding =
    entityType === "billing_statement"
      ? await statementOutstanding(admin, entityId)
      : entityType === "contract"
        ? await contractOutstanding(admin, entityId)
        : entityType === "deposit_topup"
          ? await topupOutstanding(admin, entityId)
          : await depositOutstanding(admin, entityId);

  const { data: open } = await admin
    .from("query_payment_reports")
    .select("amount, query:queries!query_payment_reports_query_id_fkey(entity_type, entity_id)")
    .eq("status", "reported");

  // PostgREST types an embedded row as an array here even though query_id is
  // unique; normalise before comparing rather than trusting either shape.
  const pending = (open ?? [])
    .filter((r) => {
      const raw = (r as unknown as { query: EmbeddedQuery | EmbeddedQuery[] | null }).query;
      const q = Array.isArray(raw) ? raw[0] ?? null : raw;
      return q?.entity_type === entityType && q?.entity_id === entityId;
    })
    .reduce((sum, r) => sum + Number((r as unknown as { amount: number }).amount || 0), 0);

  return {
    outstanding: Math.round(outstanding),
    pending: Math.round(pending),
    reportable: Math.max(0, Math.round(outstanding - pending)),
  };
}
