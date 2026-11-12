import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/invoices/[id]/gst-invoice-pdf
 *
 * Resolves the ad-hoc invoice's current (non-voided) linked billing_statements
 * row and redirects to its GST invoice PDF. A proforma_invoices row isn't
 * guaranteed to have exactly one billing_statements row over its lifetime
 * (void+reissue creates a fresh one), so this always resolves the current one
 * server-side rather than requiring the caller to know the statement id.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: statement } = await supabase
    .from("billing_statements")
    .select("id")
    .eq("invoice_id", id)
    .is("voided_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!statement) {
    return NextResponse.json({ error: "No billing statement found for this invoice" }, { status: 404 });
  }

  return NextResponse.redirect(new URL(`/api/billing-statements/${statement.id}/gst-invoice-pdf`, request.url));
}
