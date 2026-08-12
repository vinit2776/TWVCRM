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
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: caseId } = await params;
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
      "id, rate, start_date, case_source, bill_to, client_gst_number, client_name, client_company_name, aggregator:aggregators!cases_aggregator_id_fkey(gst_number, same_state_as_twv, billing_method)"
    )
    .eq("id", caseId)
    .single();

  if (caseError || !caseRow) {
    return NextResponse.json({ error: "Case not found" }, { status: 404 });
  }

  const aggregator = caseRow.aggregator as unknown as { gst_number: string | null; same_state_as_twv: boolean | null; billing_method?: string } | null;

  const eligible = caseRow.case_source === "direct" || aggregator?.billing_method === "prepaid";
  if (!eligible) {
    return NextResponse.json(
      { error: "Only prepaid-aggregator and direct-client cases can be invoiced individually. Postpaid aggregators are billed via the consolidated monthly invoice." },
      { status: 400 }
    );
  }

  try {
    const statementId = await createCaseInvoiceStatement(adminSupabase, {
      id: caseRow.id,
      rate: caseRow.rate,
      start_date: caseRow.start_date,
      case_source: caseRow.case_source,
      bill_to: caseRow.bill_to,
      client_gst_number: caseRow.client_gst_number,
      client_name: caseRow.client_name,
      client_company_name: caseRow.client_company_name,
      aggregator: aggregator ? { gst_number: aggregator.gst_number, same_state_as_twv: aggregator.same_state_as_twv } : null,
    });

    logAudit(supabase, {
      entityType: "billing_statement",
      entityId: statementId,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: { case_id: caseId, statement_type: "vo_case" } } },
    });

    return NextResponse.json({ data: { statement_id: statementId } }, { status: 201 });
  } catch (err) {
    if (err instanceof CaseInvoicingError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
