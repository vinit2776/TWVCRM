import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getTestContractIds, excludeTestContractsOrFilter } from "@/lib/test-contracts";

const PAGE_SIZE = 20;

/**
 * GET /api/accounting/receivables/written-off?page=1&limit=20&search=
 *
 * Paginated feed for the "Written Off" tab on the Accounts Receivable page —
 * same shape as /api/accounting/receivables/paid, but for statements marked
 * uncollectible via POST .../write-off instead of settled.
 *
 * The main receivables feed already excludes these (it only pulls
 * payment_status in unpaid/partially_paid), so this is the only place a
 * written-off statement's amount stays visible for reconciliation.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts", "sales_rep"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || String(PAGE_SIZE), 10) || PAGE_SIZE));
  const search = (searchParams.get("search") || "").trim();
  const offset = (page - 1) * limit;

  let query = supabase
    .from("billing_statements")
    .select(`
      id, statement_number, statement_type, period_start, period_end, total_amount,
      gst_invoice_number, status, payment_status, accounted,
      written_off_at, written_off_amount, write_off_reason,
      written_off_by_user:users!billing_statements_written_off_by_fkey(id, full_name),
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company)
      ),
      proposal:proposals!billing_statements_proposal_id_fkey(
        id, proposal_number,
        lead:leads!proposals_lead_id_fkey(id, first_name, last_name, company)
      ),
      invoice:proforma_invoices!billing_statements_invoice_id_fkey(
        id, invoice_number,
        lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company)
      ),
      case:cases!billing_statements_case_id_fkey(
        id, case_number, client_name, client_company_name, client_email, client_phone, bill_to,
        aggregator:aggregators!cases_aggregator_id_fkey(id, name, primary_email, primary_phone)
      ),
      aggregator:aggregators!billing_statements_aggregator_id_fkey(id, name, primary_email, primary_phone)
    `, { count: "exact" })
    .eq("payment_status", "written_off")
    .order("written_off_at", { ascending: false });

  // Exclude test contracts' fake statements — contract_id is nullable
  // (case/proposal/aggregator-billed statements have none and must stay).
  const testContractOrFilter = excludeTestContractsOrFilter(
    "contract_id",
    await getTestContractIds(createAdminClient())
  );
  if (testContractOrFilter) query = query.or(testContractOrFilter);

  if (search) {
    // PostgREST's .or() filter DSL treats "," and "(" / ")" as syntax —
    // strip them out of free-typed search text so it can't be misread as
    // extra filter clauses. Mirrors the paid-tab search implementation.
    const safe = search.replace(/[,()]/g, "").trim();
    if (safe) {
      const orClauses = [`statement_number.ilike.%${safe}%`, `gst_invoice_number.ilike.%${safe}%`];

      const { data: matchingLeads } = await supabase
        .from("leads")
        .select("id")
        .or(`company.ilike.%${safe}%,first_name.ilike.%${safe}%,last_name.ilike.%${safe}%`);
      const leadIds = (matchingLeads || []).map((l) => l.id as string);

      const [{ data: matchingContracts }, { data: matchingProposals }, { data: matchingInvoices }, { data: matchingAggregators }] = await Promise.all([
        supabase.from("contracts").select("id")
          .or(`contract_number.ilike.%${safe}%${leadIds.length ? `,lead_id.in.(${leadIds.join(",")})` : ""}`),
        supabase.from("proposals").select("id")
          .or(`proposal_number.ilike.%${safe}%${leadIds.length ? `,lead_id.in.(${leadIds.join(",")})` : ""}`),
        supabase.from("proforma_invoices").select("id")
          .or(`invoice_number.ilike.%${safe}%${leadIds.length ? `,lead_id.in.(${leadIds.join(",")})` : ""}`),
        supabase.from("aggregators").select("id").ilike("name", `%${safe}%`),
      ]);

      const contractIds = (matchingContracts || []).map((c) => c.id as string);
      const proposalIds = (matchingProposals || []).map((p) => p.id as string);
      const invoiceIds = (matchingInvoices || []).map((i) => i.id as string);
      const aggregatorIds = (matchingAggregators || []).map((a) => a.id as string);
      if (contractIds.length) orClauses.push(`contract_id.in.(${contractIds.join(",")})`);
      if (proposalIds.length) orClauses.push(`proposal_id.in.(${proposalIds.join(",")})`);
      if (invoiceIds.length) orClauses.push(`invoice_id.in.(${invoiceIds.join(",")})`);
      if (aggregatorIds.length) orClauses.push(`aggregator_id.in.(${aggregatorIds.join(",")})`);

      const { data: matchingCases } = await supabase.from("cases").select("id")
        .or(`case_number.ilike.%${safe}%,client_name.ilike.%${safe}%,client_company_name.ilike.%${safe}%${aggregatorIds.length ? `,aggregator_id.in.(${aggregatorIds.join(",")})` : ""}`);
      const caseIds = (matchingCases || []).map((c) => c.id as string);
      if (caseIds.length) orClauses.push(`case_id.in.(${caseIds.join(",")})`);

      query = query.or(orClauses.join(","));
    }
  }

  const { data: statements, count, error } = await query.range(offset, offset + limit - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Total written off across every matching row, not just this page — the
  // whole point of the tab is a reconciliation total, not just a paged list.
  let totalQuery = supabase
    .from("billing_statements")
    .select("written_off_amount")
    .eq("payment_status", "written_off");
  if (testContractOrFilter) totalQuery = totalQuery.or(testContractOrFilter);
  const { data: totalRows } = await totalQuery;
  const totalWrittenOff = (totalRows || []).reduce((s, r) => s + Number(r.written_off_amount || 0), 0);

  return NextResponse.json({
    rows: statements || [],
    total: count ?? (statements || []).length,
    total_written_off: totalWrittenOff,
    page,
    hasMore: offset + (statements || []).length < (count ?? 0),
  });
}
