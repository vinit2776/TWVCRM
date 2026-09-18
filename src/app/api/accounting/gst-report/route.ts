import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/accounting/gst-report?month=YYYY-MM
 *
 * Returns all GST-eligible transactions for the month in a structured
 * format suitable for building GSTR-1 / outward supply schedules.
 *
 * Includes:
 *   - Proforma/adhoc invoices (status = 'paid' with GST)
 *   - Billing statements with GST (payment_status = 'paid')
 *
 * Security deposits are NOT subject to GST (they are refundable) so
 * they are excluded from the GST report.
 *
 * Response shape:
 * {
 *   month, supplier_gstin, supplier_name,
 *   b2b: [...],  // invoices to registered buyers (buyer has GSTIN)
 *   b2c: [...],  // invoices to unregistered buyers
 *   totals: { taxable_value, cgst, sgst, igst, total }
 * }
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const month = searchParams.get("month") || new Date().toISOString().slice(0, 7);

  if (!/^\d{4}-\d{2}$/.test(month))
    return NextResponse.json({ error: "Invalid month format (expected YYYY-MM)" }, { status: 400 });

  const [y, m] = month.split("-").map(Number);
  const dateFrom = `${month}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const dateTo = `${month}-${String(lastDay).padStart(2, "0")}`;

  // ── Proforma invoices paid this month ────────────────────────────────────
  const { data: proformas } = await supabase
    .from("proforma_invoices")
    .select(`
      id, invoice_number, gst_invoice_number, title,
      subtotal, tax_percentage, tax_amount, total_amount, paid_at, payment_reference,
      lead:leads!proforma_invoices_lead_id_fkey(
        first_name, last_name, company, gst_number, state
      )
    `)
    .eq("status", "paid")
    .not("tax_amount", "is", null)
    .gt("tax_amount", 0)
    .gte("paid_at", dateFrom)
    .lte("paid_at", dateTo + "T23:59:59Z")
    .order("paid_at", { ascending: true });

  // ── Billing statements paid this month ───────────────────────────────────
  const { data: billings } = await supabase
    .from("billing_statements")
    .select(`
      id, gst_invoice_number, subtotal, tax_percentage,
      cgst_amount, sgst_amount, igst_amount, total_amount, payment_date,
      contract:contracts!billing_statements_contract_id_fkey(
        id, contract_number, is_test_contract,
        lead:leads!contracts_lead_id_fkey(
          first_name, last_name, company, gst_number, state
        )
      )
    `)
    .eq("payment_status", "paid")
    .gte("payment_date", dateFrom)
    .lte("payment_date", dateTo)
    .order("payment_date", { ascending: true });

  // Exclude test contracts' fake GST activity (contract_id is nullable —
  // proforma/case-billed statements have none and must stay included).
  const visibleBillings = (billings ?? []).filter(
    (b) => !(b.contract as { is_test_contract?: boolean } | null)?.is_test_contract
  );

  // ── Build unified line items ──────────────────────────────────────────────
  type GstLine = {
    source: "proforma" | "billing";
    source_id: string;
    invoice_number: string;
    invoice_date: string;
    buyer_name: string;
    buyer_gstin: string | null;
    buyer_state: string | null;
    is_interstate: boolean;
    description: string;
    taxable_value: number;
    tax_rate: number;
    cgst: number;
    sgst: number;
    igst: number;
    total: number;
  };

  const lines: GstLine[] = [];

  for (const p of proformas || []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = p.lead as any;
    const buyerState = (lead?.state || "").toLowerCase().trim();
    const isInterstate = buyerState !== "" && buyerState !== "tamil nadu" && buyerState !== "tn";
    const taxAmt = Number(p.tax_amount || 0);
    const subtotal = Number(p.subtotal || 0);
    const taxRate = Number(p.tax_percentage || 18);
    lines.push({
      source: "proforma",
      source_id: p.id,
      invoice_number: p.gst_invoice_number || p.invoice_number,
      invoice_date: (p.paid_at || "").slice(0, 10),
      buyer_name: lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Unknown",
      buyer_gstin: lead?.gst_number || null,
      buyer_state: lead?.state || null,
      is_interstate: isInterstate,
      description: p.title,
      taxable_value: subtotal,
      tax_rate: taxRate,
      cgst: isInterstate ? 0 : Math.round(taxAmt / 2 * 100) / 100,
      sgst: isInterstate ? 0 : Math.round(taxAmt / 2 * 100) / 100,
      igst: isInterstate ? taxAmt : 0,
      total: Number(p.total_amount || 0),
    });
  }

  for (const b of visibleBillings) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract = b.contract as any;
    const lead = contract?.lead;
    const buyerState = (lead?.state || "").toLowerCase().trim();
    const isInterstate = !!(b.igst_amount && Number(b.igst_amount) > 0);
    const cgst = Number(b.cgst_amount || 0);
    const sgst = Number(b.sgst_amount || 0);
    const igst = Number(b.igst_amount || 0);
    lines.push({
      source: "billing",
      source_id: b.id,
      invoice_number: b.gst_invoice_number || contract?.contract_number || b.id,
      invoice_date: b.payment_date || "",
      buyer_name: lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Unknown",
      buyer_gstin: lead?.gst_number || null,
      buyer_state: lead?.state || buyerState || null,
      is_interstate: isInterstate,
      description: `Monthly charge — ${contract?.contract_number || ""}`,
      taxable_value: Number(b.subtotal || 0),
      tax_rate: Number(b.tax_percentage || 18),
      cgst,
      sgst,
      igst,
      total: Number(b.total_amount || 0),
    });
  }

  const b2b = lines.filter((l) => !!l.buyer_gstin);
  const b2c = lines.filter((l) => !l.buyer_gstin);

  const sumLines = (arr: GstLine[]) => ({
    taxable_value: arr.reduce((s, l) => s + l.taxable_value, 0),
    cgst: arr.reduce((s, l) => s + l.cgst, 0),
    sgst: arr.reduce((s, l) => s + l.sgst, 0),
    igst: arr.reduce((s, l) => s + l.igst, 0),
    total: arr.reduce((s, l) => s + l.total, 0),
  });

  return NextResponse.json({
    month,
    date_from: dateFrom,
    date_to: dateTo,
    supplier_gstin: "33AAACU4245J1ZF",
    supplier_name: "SREE DESIGN INFRASTRUCTURE PVT LTD",
    supplier_state: "Tamil Nadu",
    b2b,
    b2c,
    all: lines,
    totals: sumLines(lines),
    b2b_totals: sumLines(b2b),
    b2c_totals: sumLines(b2c),
  });
}
