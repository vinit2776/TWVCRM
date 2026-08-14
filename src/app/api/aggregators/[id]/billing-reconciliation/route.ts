import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/aggregators/[id]/billing-reconciliation
 *
 * Powers the Referrals list on the aggregator Billing tab — every currently
 * billable case for this aggregator, split into "pending" (no non-voided
 * billing_statement_cases row yet) and "billed" (linked to one, with the
 * owning statement's live payment/handoff state). billing_statement_cases is
 * the source of truth for "billed", not the legacy aggregator_invoices.items
 * JSONB snapshot — a voided statement correctly drops its cases back into
 * the pending pool for the next invoice.
 */

const BILLABLE_CASE_STATUSES = ["active", "renewal_due", "invoiced", "executed"];

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: cases, error: casesError } = await supabase
    .from("cases")
    .select("id, case_number, client_name, purpose, rate, status")
    .eq("aggregator_id", id)
    .in("status", BILLABLE_CASE_STATUSES)
    .order("case_number", { ascending: true });

  if (casesError) return NextResponse.json({ error: casesError.message }, { status: 500 });

  const caseIds = (cases || []).map((c) => c.id);
  if (caseIds.length === 0) {
    return NextResponse.json({ data: { pending: [], billed: [] } });
  }

  const { data: bscRows, error: bscError } = await supabase
    .from("billing_statement_cases")
    .select(`
      case_id, amount,
      billing_statement:billing_statements!billing_statement_cases_billing_statement_id_fkey(
        id, statement_number, status, handoff_state, payment_status, voided_at, proforma_sent_at, gst_invoice_number, issuance_channel
      )
    `)
    .in("case_id", caseIds);

  if (bscError) return NextResponse.json({ error: bscError.message }, { status: 500 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const billedByCase = new Map<string, { amount: number; statement: any }>();
  for (const row of bscRows || []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const statement = row.billing_statement as any;
    if (!statement || statement.voided_at) continue;
    billedByCase.set(row.case_id, { amount: row.amount, statement });
  }

  const pending = [];
  const billed = [];
  for (const c of cases || []) {
    const entry = billedByCase.get(c.id);
    if (entry) {
      billed.push({
        id: c.id,
        case_number: c.case_number,
        client_name: c.client_name,
        purpose: c.purpose,
        rate: c.rate,
        amount: entry.amount,
        statement: {
          id: entry.statement.id,
          statement_number: entry.statement.statement_number,
          status: entry.statement.status,
          handoff_state: entry.statement.handoff_state,
          payment_status: entry.statement.payment_status,
          proforma_sent_at: entry.statement.proforma_sent_at,
          gst_invoice_number: entry.statement.gst_invoice_number,
          issuance_channel: entry.statement.issuance_channel,
        },
      });
    } else {
      pending.push({
        id: c.id,
        case_number: c.case_number,
        client_name: c.client_name,
        purpose: c.purpose,
        rate: c.rate,
      });
    }
  }

  return NextResponse.json({ data: { pending, billed } });
}
