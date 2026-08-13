import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { createCaseInvoiceStatement, CaseInvoicingError } from "@/lib/case-invoicing";

/**
 * POST /api/cases/[id]/invoice
 *
 * "Generate Invoice" action for prepaid-aggregator and direct-client VO
 * cases — postpaid aggregators are billed via the consolidated monthly
 * flow (src/lib/aggregator-invoicing.ts), not per case.
 *
 * Body: { preview?: boolean } — when true, a proforma_first statement is
 * created but NOT dispatched, so the caller can show a preview (amount +
 * recipient + optional CC emails) before the operator confirms the send
 * via POST /api/cases/[id]/invoice/send. Has no effect on gst_direct
 * cases — those never dispatch from this route regardless.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
  const body = await request.json().catch(() => ({})) as { preview?: boolean };
  const previewOnly = body.preview === true;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  const ALLOWED_ROLES = ["admin", "manager", "sales_rep", "office_admin"];
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not authorized to generate case invoices" }, { status: 403 });
  }

  const adminSupabase = await createAdminClient();

  const { data: caseRow, error: caseError } = await adminSupabase
    .from("cases")
    .select(
      "id, rate, start_date, tenure_months, case_source, bill_to, billing_mode, client_gst_number, client_name, client_company_name, aggregator:aggregators!cases_aggregator_id_fkey(gst_number, same_state_as_twv, billing_method, billing_mode)"
    )
    .eq("id", caseId)
    .single();

  if (caseError || !caseRow) {
    return NextResponse.json({ error: "Case not found" }, { status: 404 });
  }

  const aggregator = caseRow.aggregator as unknown as { gst_number: string | null; same_state_as_twv: boolean | null; billing_method?: string; billing_mode?: "proforma_first" | "gst_direct" } | null;

  const eligible = caseRow.case_source === "direct" || aggregator?.billing_method === "prepaid";
  if (!eligible) {
    return NextResponse.json(
      { error: "Only prepaid-aggregator and direct-client cases can be invoiced individually. Postpaid aggregators are billed via the consolidated monthly invoice." },
      { status: 400 }
    );
  }

  try {
    const result = await createCaseInvoiceStatement(adminSupabase, {
      id: caseRow.id,
      rate: caseRow.rate,
      start_date: caseRow.start_date,
      tenure_months: caseRow.tenure_months,
      case_source: caseRow.case_source,
      bill_to: caseRow.bill_to,
      billing_mode: caseRow.billing_mode,
      client_gst_number: caseRow.client_gst_number,
      client_name: caseRow.client_name,
      client_company_name: caseRow.client_company_name,
      aggregator: aggregator ? { gst_number: aggregator.gst_number, same_state_as_twv: aggregator.same_state_as_twv, billing_mode: aggregator.billing_mode } : null,
    }, { dispatch: !previewOnly });

    logAudit(supabase, {
      entityType: "billing_statement",
      entityId: result.statementId,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: { case_id: caseId, statement_type: "vo_case" } } },
    });

    let preview: { statement_number: string | null; total_amount: number } | null = null;
    if (result.requiresManualSend) {
      const { data: stmt } = await adminSupabase
        .from("billing_statements")
        .select("statement_number, total_amount")
        .eq("id", result.statementId)
        .single();
      preview = { statement_number: stmt?.statement_number ?? null, total_amount: Number(stmt?.total_amount ?? 0) };
    }

    return NextResponse.json({
      data: { statement_id: result.statementId, requires_send: result.requiresManualSend, preview },
    }, { status: 201 });
  } catch (err) {
    if (err instanceof CaseInvoicingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
