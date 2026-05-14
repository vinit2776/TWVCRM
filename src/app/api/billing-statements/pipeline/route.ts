import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

type Stage =
  | "voided"
  | "draft"
  | "finalized"
  | "proforma_sent"
  | "partially_paid"
  | "paid"
  | "gst_sent_unpaid"
  | "invoiced"
  | "complete";

function resolveStage(s: {
  status: string;
  payment_status: string | null;
  accounted: boolean | null;
  gst_invoice_number: string | null;
  proforma_sent_at: string | null;
}): Stage {
  if (s.status === "voided") return "voided";
  const isFinalized = s.status === "finalized" || s.status === "exported";
  if (!isFinalized) return "draft";
  if (s.accounted && s.gst_invoice_number) return "complete";
  if (s.gst_invoice_number && s.payment_status === "paid") return "invoiced";
  if (s.gst_invoice_number) return "gst_sent_unpaid"; // GST sent but not yet paid
  if (s.payment_status === "paid") return "paid";
  if (s.payment_status === "partially_paid") return "partially_paid";
  if (s.proforma_sent_at) return "proforma_sent";
  return "finalized";
}

/**
 * GET /api/billing-statements/pipeline?year=&month=
 *
 * Returns per-stage counts for all billing statements in the given month.
 * Used by BillingPipelineBar on the Billing — Acc Receivables page.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = createAdminClient();
  const { searchParams } = new URL(request.url);
  const year  = parseInt(searchParams.get("year")  || new Date().getFullYear().toString());
  const month = parseInt(searchParams.get("month") || (new Date().getMonth() + 1).toString());

  const periodStart = new Date(year, month - 1, 1).toISOString().split("T")[0];
  const periodEnd   = new Date(year, month, 0).toISOString().split("T")[0];

  const { data: rows, error } = await adminSupabase
    .from("billing_statements")
    .select("status, payment_status, accounted, gst_invoice_number, proforma_sent_at, total_amount")
    .gte("period_start", periodStart)
    .lte("period_end", periodEnd);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const counts: Record<Stage, number> = {
    draft:           0,
    finalized:       0,
    proforma_sent:   0,
    partially_paid:  0,
    paid:            0,
    gst_sent_unpaid: 0,
    invoiced:        0,
    complete:        0,
    voided:          0,
  };
  const amounts: Record<Stage, number> = { ...counts };

  for (const row of rows || []) {
    const stage = resolveStage(row);
    counts[stage]++;
    amounts[stage] += Number(row.total_amount || 0);
  }

  const total = (rows || []).filter((r) => r.status !== "voided").length;

  return NextResponse.json({ data: { counts, amounts, total, year, month } });
}
