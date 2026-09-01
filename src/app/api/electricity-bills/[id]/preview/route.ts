import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { generateGstInvoicePDF, type GstInvoiceData } from "@/lib/gst-invoice-generator";

interface CustomerBillRow {
  id: string;
  bill_side: string;
  contract_id: string | null;
  bill_month: number;
  bill_year: number;
  customer_subtotal: number | null;
  customer_cgst: number | null;
  customer_sgst: number | null;
  customer_total: number | null;
  customer_utility_pct: number | null;
  customer_generator_pct: number | null;
  customer_units_billed: number | null;
  customer_utility_rate: number | null;
  customer_generator_rate: number | null;
  gst_rate: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * GET /api/electricity-bills/[id]/preview
 *
 * Renders the exact PDF the customer will receive on dispatch — same line-item
 * math, same generateGstInvoicePDF() renderer used by dispatchProforma /
 * dispatchGstDirect — but nothing is persisted or sent. No billing_statement
 * row is created, no Razorpay link is minted; this is purely a read-only
 * render so accounts can sanity-check before the "Bill & Send" action.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  if (!["admin", "manager", "accounts", "office_admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rawBill, error: billErr } = await (supabase as any)
    .from("electricity_bills")
    .select(
      "id, bill_side, contract_id, bill_month, bill_year, customer_subtotal, customer_cgst, " +
        "customer_sgst, customer_total, customer_utility_pct, customer_generator_pct, " +
        "customer_units_billed, customer_utility_rate, customer_generator_rate, gst_rate",
    )
    .eq("id", id)
    .single();

  if (billErr || !rawBill) {
    return NextResponse.json({ error: "Bill not found" }, { status: 404 });
  }
  const bill = rawBill as CustomerBillRow;

  if (bill.bill_side !== "customer" || !bill.contract_id) {
    return NextResponse.json({ error: "Only generated customer bills can be previewed" }, { status: 422 });
  }

  const { data: contract } = await supabase
    .from("contracts")
    .select("contract_number, billing_mode, po_number, lead:leads!contracts_lead_id_fkey(company, first_name, last_name, gst_number, state)")
    .eq("id", bill.contract_id)
    .single();

  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 422 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = (contract as any).lead;

  // ── Period + due date — same computation as dispatch/route.ts ─────────────
  const paddedMonth = String(bill.bill_month).padStart(2, "0");
  const periodStart = `${bill.bill_year}-${paddedMonth}-01`;
  const lastDay = new Date(bill.bill_year, bill.bill_month, 0).getDate();
  const periodEnd = `${bill.bill_year}-${paddedMonth}-${String(lastDay).padStart(2, "0")}`;
  const monthLabel = new Date(bill.bill_year, bill.bill_month - 1).toLocaleString("en-IN", { month: "long", year: "numeric" });

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  istNow.setUTCDate(istNow.getUTCDate() + 7);
  const dueDate = istNow.toISOString().slice(0, 10);

  // ── Same Utility/DG breakdown the dispatch route builds ────────────────────
  const totalUnits = Number(bill.customer_units_billed ?? 0);
  const utilityUnits = round2((totalUnits * Number(bill.customer_utility_pct ?? 0)) / 100);
  const generatorUnits = round2((totalUnits * Number(bill.customer_generator_pct ?? 0)) / 100);

  const lineItems: GstInvoiceData["lineItems"] = [];
  if (utilityUnits > 0) {
    const rate = Number(bill.customer_utility_rate ?? 0);
    lineItems.push({
      description: `Electricity — Utility/Grid (${monthLabel})`,
      hsnSac: "996912",
      qty: utilityUnits,
      rate,
      amount: round2(utilityUnits * rate),
    });
  }
  if (generatorUnits > 0) {
    const rate = Number(bill.customer_generator_rate ?? 0);
    lineItems.push({
      description: `Electricity — DG/Generator (${monthLabel})`,
      hsnSac: "996912",
      qty: generatorUnits,
      rate,
      amount: round2(generatorUnits * rate),
    });
  }

  const isGstDirect = (contract as { billing_mode?: string | null }).billing_mode === "gst_direct";

  const invoiceData: GstInvoiceData = {
    invoiceNumber: "PREVIEW",
    invoiceDate: new Date().toISOString().slice(0, 10),
    isProforma: !isGstDirect,
    buyerName: lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "Customer",
    buyerGstin: lead?.gst_number || undefined,
    buyerState: lead?.state || undefined,
    periodStart,
    periodEnd,
    dueDate: !isGstDirect ? dueDate : undefined,
    contractNumber: (contract as { contract_number: string }).contract_number,
    poNumber: (contract as { po_number?: string | null }).po_number,
    lineItems,
    subtotal: Number(bill.customer_subtotal ?? 0),
    cgst: Number(bill.customer_cgst ?? 0),
    sgst: Number(bill.customer_sgst ?? 0),
    igst: 0,
    totalAmount: Number(bill.customer_total ?? 0),
    isInterstate: false,
    taxPercentage: Number(bill.gst_rate ?? 18),
  };

  const doc = generateGstInvoicePDF(invoiceData);
  const pdfBuffer = Buffer.from(doc.output("arraybuffer"));

  return new NextResponse(pdfBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline; filename=electricity-bill-preview.pdf",
      "Cache-Control": "no-store",
    },
  });
}
