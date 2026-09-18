import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET  /api/accounting/proposal-payments?month=YYYY-MM
 *   Returns all proposal-level payments for a given month:
 *     - proforma/adhoc invoices paid  (proforma_invoices.status = 'paid')
 *     - billing statement payments    (billing_statements.payment_status = 'paid')
 *   Security deposit accounting lives in Tally Inbox → Deposits instead
 *   (see /api/accounting/inbox/deposits) — it requires a Tally receipt
 *   upload, not just a toggle.
 *
 * PATCH /api/accounting/proposal-payments
 *   Body: { type: "proforma"|"billing", id: string, accounted: boolean }
 *   Marks a payment row as accounted (or unmarks it).
 */

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month"); // e.g. "2026-04"

  let dateFrom: string, dateTo: string;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    dateFrom = `${month}-01`;
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    dateTo = `${month}-${String(lastDay).padStart(2, "0")}`;
  } else {
    // Default: current month
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    dateFrom = `${y}-${String(m).padStart(2, "0")}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    dateTo = `${y}-${String(m).padStart(2, "0")}-${lastDay}`;
  }

  // ── 1. Proforma / adhoc invoices paid this month ─────────────────────────
  const { data: proformas } = await supabase
    .from("proforma_invoices")
    .select(`
      id, invoice_number, title, total_amount, subtotal,
      tax_percentage, tax_amount, status, paid_at,
      payment_reference, gst_invoice_number,
      accounted, accounted_at, accounted_by,
      lead:leads!proforma_invoices_lead_id_fkey(id, first_name, last_name, company, gst_number, state)
    `)
    .eq("status", "paid")
    .gte("paid_at", dateFrom)
    .lte("paid_at", dateTo + "T23:59:59Z")
    .order("paid_at", { ascending: true });

  // ── 2. Billing statements paid this month ────────────────────────────────
  const { data: billings } = await supabase
    .from("billing_statements")
    .select(`
      id, gst_invoice_number, total_amount, subtotal,
      cgst_amount, sgst_amount, igst_amount, tax_percentage,
      payment_status, payment_date, gst_invoice_status,
      accounted, accounted_at, accounted_by,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, is_test_contract,
        lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, gst_number, state)
      )
    `)
    .eq("payment_status", "paid")
    .gte("payment_date", dateFrom)
    .lte("payment_date", dateTo)
    .order("payment_date", { ascending: true });

  // Exclude test contracts' fake payments (contract_id is nullable —
  // proforma/case-billed statements have none and must stay included).
  const visibleBillings = (billings ?? []).filter(
    (b) => !(b.contract as { is_test_contract?: boolean } | null)?.is_test_contract
  );

  return NextResponse.json({
    month: month || new Date().toISOString().slice(0, 7),
    date_from: dateFrom,
    date_to: dateTo,
    proformas: proformas || [],
    billings: visibleBillings,
    summary: {
      proforma_count: (proformas || []).length,
      proforma_total: (proformas || []).reduce((s, p) => s + Number(p.total_amount || 0), 0),
      billing_count: visibleBillings.length,
      billing_total: visibleBillings.reduce((s, b) => s + Number(b.total_amount || 0), 0),
      unaccounted_count:
        (proformas || []).filter((p) => !p.accounted).length +
        visibleBillings.filter((b) => !b.accounted).length,
    },
  });
}

export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { type, id, accounted } = body as { type: string; id: string; accounted: boolean };

  if (!type || !id || typeof accounted !== "boolean")
    return NextResponse.json({ error: "type, id and accounted are required" }, { status: 400 });

  const now = new Date().toISOString();

  if (type === "proforma") {
    const { error } = await supabase
      .from("proforma_invoices")
      .update({
        accounted,
        accounted_at: accounted ? now : null,
        accounted_by: accounted ? user.id : null,
      })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else if (type === "billing") {
    const { error } = await supabase
      .from("billing_statements")
      .update({
        accounted,
        accounted_at: accounted ? now : null,
        accounted_by: accounted ? user.id : null,
      })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  }

  return NextResponse.json({ ok: true, accounted });
}
