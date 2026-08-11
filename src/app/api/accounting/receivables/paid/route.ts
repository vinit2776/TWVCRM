import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const PAGE_SIZE = 20;

/**
 * GET /api/accounting/receivables/paid?page=1&limit=20&search=
 *
 * Paginated feed for the "Paid" tab on the Accounts Receivable page.
 * Unlike /api/accounting/receivables (which fetches the whole open-AR set
 * in one call because it's naturally bounded), the paid history only grows —
 * so this is server-paginated with .range() rather than loaded in full.
 *
 * Sorted by billing_statements.updated_at desc as a proxy for "most recently
 * paid": the record-payment flow updates payment_status on the statement row
 * itself, so the trigger-maintained updated_at tracks the last payment.
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
      gst_invoice_number, updated_at,
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
      )
    `, { count: "exact" })
    .in("status", ["finalized", "exported"])
    .eq("payment_status", "paid")
    .is("voided_at", null)
    .order("updated_at", { ascending: false });

  if (search) {
    // PostgREST's .or() filter DSL treats "," and "(" / ")" as syntax —
    // strip them out of free-typed search text so it can't be misread as
    // extra filter clauses.
    const safe = search.replace(/[,()]/g, "").trim();
    if (safe) {
      const orClauses = [`statement_number.ilike.%${safe}%`, `gst_invoice_number.ilike.%${safe}%`];

      // Customer name / company and contract/proposal/invoice number live on
      // joined tables, which PostgREST can't OR-filter alongside top-level
      // columns in one request — resolve matching ids first, then fold them
      // into the same .or() as an `.in()` clause.
      const { data: matchingLeads } = await supabase
        .from("leads")
        .select("id")
        .or(`company.ilike.%${safe}%,first_name.ilike.%${safe}%,last_name.ilike.%${safe}%`);
      const leadIds = (matchingLeads || []).map((l) => l.id as string);

      const [{ data: matchingContracts }, { data: matchingProposals }, { data: matchingInvoices }] = await Promise.all([
        supabase.from("contracts").select("id")
          .or(`contract_number.ilike.%${safe}%${leadIds.length ? `,lead_id.in.(${leadIds.join(",")})` : ""}`),
        supabase.from("proposals").select("id")
          .or(`proposal_number.ilike.%${safe}%${leadIds.length ? `,lead_id.in.(${leadIds.join(",")})` : ""}`),
        supabase.from("proforma_invoices").select("id")
          .or(`invoice_number.ilike.%${safe}%${leadIds.length ? `,lead_id.in.(${leadIds.join(",")})` : ""}`),
      ]);

      const contractIds = (matchingContracts || []).map((c) => c.id as string);
      const proposalIds = (matchingProposals || []).map((p) => p.id as string);
      const invoiceIds = (matchingInvoices || []).map((i) => i.id as string);
      if (contractIds.length) orClauses.push(`contract_id.in.(${contractIds.join(",")})`);
      if (proposalIds.length) orClauses.push(`proposal_id.in.(${proposalIds.join(",")})`);
      if (invoiceIds.length) orClauses.push(`invoice_id.in.(${invoiceIds.join(",")})`);

      query = query.or(orClauses.join(","));
    }
  }

  const { data: statements, count, error } = await query.range(offset, offset + limit - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const statementIds = (statements || []).map((s) => s.id as string);
  const paidInfoByStatement = new Map<string, { paid_on: string; payment_mode: string }>();
  if (statementIds.length > 0) {
    const { data: payments } = await supabase
      .from("billing_payments")
      .select("billing_statement_id, payment_date, payment_mode, created_at")
      .in("billing_statement_id", statementIds)
      .order("created_at", { ascending: true });

    // Last payment recorded per statement drives "Paid on" / "Mode"; a
    // statement settled across multiple partial payments shows "Multiple".
    const modesByStatement = new Map<string, Set<string>>();
    for (const p of payments || []) {
      const sid = p.billing_statement_id as string;
      paidInfoByStatement.set(sid, { paid_on: p.payment_date as string, payment_mode: p.payment_mode as string });
      if (!modesByStatement.has(sid)) modesByStatement.set(sid, new Set());
      modesByStatement.get(sid)!.add(p.payment_mode as string);
    }
    for (const [sid, info] of paidInfoByStatement) {
      const modes = modesByStatement.get(sid);
      if (modes && modes.size > 1) info.payment_mode = "Multiple";
    }
  }

  const rows = (statements || []).map((s) => {
    const info = paidInfoByStatement.get(s.id as string);
    return {
      ...s,
      paid_on: info?.paid_on ?? null,
      payment_mode: info?.payment_mode ?? null,
    };
  });

  return NextResponse.json({
    rows,
    total: count ?? rows.length,
    page,
    hasMore: offset + rows.length < (count ?? 0),
  });
}
