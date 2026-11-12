import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A renewal that starts mid-month owes a pro-rata invoice for the partial first
 * month: the monthly rent run opens at the FOLLOWING month (`firstBillingAnchor`)
 * on the assumption that this invoice covers the gap. Nothing else raises it, so
 * activation refuses to complete until it has been dealt with — see
 * `getRenewalProrataGate` and the PATCH handler in contracts/[id]/route.ts.
 */

export interface ProrataStatementState {
  payment_status?: string | null;
  proforma_sent_at?: string | null;
  handoff_state?: string | null;
  issuance_channel?: string | null;
}

export interface ProrataCoverageRow {
  statement_type: string;
  period_start: string;
  period_end: string;
  prepaid_month?: number | null;
  prepaid_year?: number | null;
  voided_at?: string | null;
}

/** The customer has actually been billed: a PI emailed, the invoice handed to
 *  the Tally Inbox, or it is already paid. A statement that merely exists (the
 *  send failed or was never clicked) does not count. */
export function prorataStatementDispatched(s: ProrataStatementState | null | undefined): boolean {
  if (!s) return false;
  return s.payment_status === "paid"
    || !!s.proforma_sent_at
    || !!s.handoff_state
    || s.issuance_channel === "tally";
}

/** Rent already billed for the renewal's start month on the parent while the
 *  renewal awaited activation (statements tagged billed_on_behalf_of_contract_id).
 *  A pro-rata on top of that would double-bill the opening days. */
export function startMonthCoveredByParentBilling(startDate: string, rows: ProrataCoverageRow[]): boolean {
  const year = +startDate.slice(0, 4);
  const month = +startDate.slice(5, 7);
  return rows.some((r) => {
    if (r.voided_at) return false;
    if (r.statement_type !== "rent" && r.statement_type !== "combined") return false;
    if (r.prepaid_month === month && r.prepaid_year === year) return true;
    return r.period_start <= startDate && startDate <= r.period_end;
  });
}

export interface RenewalProrataGate {
  /** True while activation must be blocked. */
  blocking: boolean;
  /** Why it is blocking, or why it is not. */
  reason: "not_applicable" | "paid" | "waived" | "sent" | "covered_by_parent_billing" | "unsent";
}

export function evaluateRenewalProrataGate(opts: {
  isRenewal: boolean;
  prorataStatus: string | null | undefined;
  startDate: string;
  statement: ProrataStatementState | null;
  parentBilledRows: ProrataCoverageRow[];
}): RenewalProrataGate {
  if (!opts.isRenewal || !opts.prorataStatus || opts.prorataStatus === "not_applicable") {
    return { blocking: false, reason: "not_applicable" };
  }
  if (opts.prorataStatus === "paid") return { blocking: false, reason: "paid" };
  if (opts.prorataStatus === "waived") return { blocking: false, reason: "waived" };
  if (prorataStatementDispatched(opts.statement)) return { blocking: false, reason: "sent" };
  if (startMonthCoveredByParentBilling(opts.startDate, opts.parentBilledRows)) {
    return { blocking: false, reason: "covered_by_parent_billing" };
  }
  return { blocking: true, reason: "unsent" };
}

export const PRORATA_UNSENT_ERROR =
  "Cannot activate: this renewal starts mid-month and the pro-rata invoice for the balance of the month has not been sent. "
  + "Send it from the Pro-Rata card on this contract (an admin can waive it with a reason), then activate.";

/** Loads what the gate needs and evaluates it. `admin` bypasses RLS: the gate
 *  must not depend on who is looking. */
export async function getRenewalProrataGate(
  admin: SupabaseClient,
  contract: {
    id: string;
    is_renewal?: boolean | null;
    prorata_payment_status?: string | null;
    prorata_billing_statement_id?: string | null;
    start_date: string;
  },
): Promise<RenewalProrataGate> {
  const needsLookup = !!contract.is_renewal
    && !!contract.prorata_payment_status
    && !["not_applicable", "paid", "waived"].includes(contract.prorata_payment_status);
  if (!needsLookup) {
    return evaluateRenewalProrataGate({
      isRenewal: !!contract.is_renewal,
      prorataStatus: contract.prorata_payment_status,
      startDate: contract.start_date,
      statement: null,
      parentBilledRows: [],
    });
  }

  let statement: ProrataStatementState | null = null;
  if (contract.prorata_billing_statement_id) {
    const { data } = await admin
      .from("billing_statements")
      .select("payment_status, proforma_sent_at, handoff_state, issuance_channel")
      .eq("id", contract.prorata_billing_statement_id)
      .maybeSingle();
    statement = (data as ProrataStatementState | null) ?? null;
  }

  const { data: parentBilled } = await admin
    .from("billing_statements")
    .select("statement_type, period_start, period_end, prepaid_month, prepaid_year, voided_at")
    .eq("billed_on_behalf_of_contract_id", contract.id);

  return evaluateRenewalProrataGate({
    isRenewal: true,
    prorataStatus: contract.prorata_payment_status,
    startDate: contract.start_date,
    statement,
    parentBilledRows: (parentBilled ?? []) as ProrataCoverageRow[],
  });
}
