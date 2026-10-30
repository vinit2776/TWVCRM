import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const PAGE_SIZE = 20;

/**
 * GET /api/accounting/receivables/cancelled?page=1&limit=20&search=
 *
 * Feed for the "Cancelled" tab on Accounts Receivable. A cancelled invoice is
 * voided, so the open-AR feed drops it; this is where the reason it was
 * cancelled, who did it and when stay visible. Keyed on lifecycle_stage =
 * 'cancelled' (set by the cancel and credit-note routes) so a plain /void
 * — correct and re-issue — never shows up here.
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
  const search = (searchParams.get("search") || "").replace(/[,()]/g, "").trim();
  const offset = (page - 1) * limit;

  let query = supabase
    .from("billing_statements")
    .select(`
      id, statement_number, statement_type, total_amount, gst_invoice_number,
      voided_at, void_reason, tally_credit_note_number,
      voided_by_user:users!billing_statements_voided_by_fkey(id, full_name),
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company)
      ),
      invoice:proforma_invoices!billing_statements_invoice_id_fkey(
        id, invoice_number,
        lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company)
      )
    `, { count: "exact" })
    .eq("lifecycle_stage", "cancelled")
    .not("voided_at", "is", null)
    .order("voided_at", { ascending: false });

  if (search) {
    query = query.or(`statement_number.ilike.%${search}%,gst_invoice_number.ilike.%${search}%,void_reason.ilike.%${search}%`);
  }

  const { data, count, error } = await query.range(offset, offset + limit - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    rows: data || [],
    total: count ?? (data || []).length,
    page,
    hasMore: offset + (data || []).length < (count ?? 0),
  });
}
