import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const INVOICE_FIELDS =
  "id, invoice_number, title, status, total_amount, paid_at, payment_reference, " +
  "gst_invoice_number, due_date, created_at, contract_id, attribution_purpose, attributed_at";

/**
 * Ad-hoc invoices (proforma_invoices) tied to this contract, plus the ones that
 * *could* be tied to it — same customer, not already attributed elsewhere.
 *
 * The candidate list is what makes retroactive attribution usable: staff land on
 * a contract that won't activate and need to find the invoice that actually
 * collected the money, without leaving the page.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: contract } = await supabase
    .from("contracts")
    .select("id, lead_id")
    .eq("id", id)
    .single();

  if (!contract) return NextResponse.json({ error: "Contract not found" }, { status: 404 });

  const { data: attributed, error } = await supabase
    .from("proforma_invoices")
    .select(INVOICE_FIELDS)
    .eq("contract_id", id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let candidates: unknown[] = [];
  if (contract.lead_id) {
    // Cancelled invoices are excluded here for the same reason POST
    // /api/invoices/[id]/attribution rejects them — they collected nothing.
    const { data } = await supabase
      .from("proforma_invoices")
      .select(INVOICE_FIELDS)
      .eq("lead_id", contract.lead_id)
      .is("contract_id", null)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false });
    candidates = data || [];
  }

  return NextResponse.json({
    data: {
      attributed: attributed || [],
      candidates,
    },
  });
}
