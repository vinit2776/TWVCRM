import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isInboxRole } from "@/lib/tally-handoff";

/**
 * GET /api/accounting/inbox/cancellations[?count=1]
 *
 * GST invoices an admin/manager has asked to cancel, waiting for Accounts to
 * issue a credit note in Tally and upload it. A row leaves this list when
 * upload-credit-note voids the statement, or when the request is withdrawn.
 * Independent of handoff_state on purpose — it is a separate task type, not a
 * stage of the GST-issuing flow.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).maybeSingle();
  if (!dbUser || !isInboxRole(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (new URL(req.url).searchParams.get("count")) {
    const { count } = await supabase
      .from("billing_statements")
      .select("id", { count: "exact", head: true })
      .not("cancellation_requested_at", "is", null)
      .is("voided_at", null);
    return NextResponse.json({ open_count: count ?? 0 });
  }

  const { data, error } = await supabase
    .from("billing_statements")
    .select(`
      id, statement_number, total_amount, payment_status, tally_invoice_number,
      cancellation_requested_at, cancellation_reason,
      requested_by_user:users!billing_statements_cancellation_requested_by_fkey(id, full_name),
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company)
      ),
      invoice:proforma_invoices!billing_statements_invoice_id_fkey(
        id, invoice_number,
        lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company)
      )
    `)
    .not("cancellation_requested_at", "is", null)
    .is("voided_at", null)
    .order("cancellation_requested_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ rows: data || [], open_count: (data || []).length });
}
