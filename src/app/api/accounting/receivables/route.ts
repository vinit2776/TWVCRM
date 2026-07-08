import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/accounting/receivables
 *
 * The data feed for the Accounts Receivable page. Returns every billing
 * statement that is finalized + not yet fully paid, enriched with contract +
 * lead + paid-to-date + computed days_overdue. The page does all bucket
 * filtering client-side so flipping between "All / Due soon / Overdue" is
 * instant.
 *
 * Excludes voided statements (voided_at IS NOT NULL).
 */
export async function GET(_req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Unpaid + partially-paid finalized statements only. We never chase drafts
  // (nothing has been sent) or voided statements (back-references replaced by
  // a fresh draft).
  const { data: statements, error } = await supabase
    .from("billing_statements")
    .select(`
      id, statement_number, statement_type, period_start, period_end, due_date,
      subtotal, tax_amount, total_amount, payment_status, status,
      proforma_sent_at, proforma_viewed_at, gst_invoice_viewed_at,
      razorpay_payment_link_url, razorpay_payment_link_id,
      last_reminder_sent_at, reminder_count, voided_at, created_at,
      gst_invoice_number, pi_cancelled_at, accounted,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, title, billing_mode,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, billing_emails)
      ),
      proposal:proposals!billing_statements_proposal_id_fkey(
        id, proposal_number,
        lead:leads!proposals_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, billing_emails)
      ),
      invoice:proforma_invoices!billing_statements_invoice_id_fkey(
        id, invoice_number,
        lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company, email, phone, mobile, billing_emails)
      )
    `)
    .in("status", ["finalized", "exported"])
    .in("payment_status", ["unpaid", "partially_paid"])
    .is("voided_at", null)
    .order("due_date", { ascending: true, nullsFirst: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const statementIds = (statements || []).map((s) => s.id as string);
  // One round-trip to sum payments per statement instead of N selects.
  let paidByStatement = new Map<string, number>();
  if (statementIds.length > 0) {
    const { data: pays } = await supabase
      .from("billing_payments")
      .select("billing_statement_id, amount")
      .in("billing_statement_id", statementIds);
    paidByStatement = (pays || []).reduce((map, p: { billing_statement_id: string; amount: number }) => {
      map.set(p.billing_statement_id, (map.get(p.billing_statement_id) || 0) + Number(p.amount));
      return map;
    }, new Map<string, number>());
  }

  // Today in IST as a YYYY-MM-DD anchor for daysOverdue.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const todayIst = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const todayMs = Date.parse(todayIst + "T00:00:00Z");

  const rows = (statements || []).map((s) => {
    const paid = paidByStatement.get(s.id as string) || 0;
    const balance = Math.max(0, Number(s.total_amount) - paid);
    let daysOverdue: number | null = null;
    if (s.due_date) {
      const dueMs = Date.parse((s.due_date as string) + "T00:00:00Z");
      daysOverdue = Math.floor((todayMs - dueMs) / 86400000);
    }
    return {
      ...s,
      amount_paid: Math.round(paid),
      balance_due: Math.round(balance),
      days_overdue: daysOverdue,
    };
  });

  // Quick aggregates for the header cards.
  const summary = {
    total_outstanding: rows.reduce((s, r) => s + r.balance_due, 0),
    count: rows.length,
    due_soon: rows.filter((r) => r.days_overdue !== null && r.days_overdue >= -7 && r.days_overdue < 0).length,
    overdue: rows.filter((r) => r.days_overdue !== null && r.days_overdue >= 0).length,
    overdue_30: rows.filter((r) => r.days_overdue !== null && r.days_overdue >= 30).length,
    oldest_days: rows.reduce((m, r) => Math.max(m, r.days_overdue ?? -Infinity), -Infinity),
  };

  return NextResponse.json({ rows, summary });
}
