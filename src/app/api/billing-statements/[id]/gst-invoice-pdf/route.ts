import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/billing-statements/[id]/gst-invoice-pdf
 *
 * Returns a signed download URL for the GST invoice PDF stored on the billing statement.
 * Used by the GST Invoices tab when the invoice was generated via the billing statement flow
 * (as opposed to the older contract_payments upload flow).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: statement } = await supabase
    .from("billing_statements")
    .select("id, gst_invoice_number, gst_invoice_path")
    .eq("id", id)
    .single();

  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });

  if (!statement.gst_invoice_path) {
    return NextResponse.json({ error: "No GST invoice PDF available for this statement" }, { status: 404 });
  }

  const { data: signedUrl, error: signedError } = await supabase.storage
    .from("crm-documents")
    .createSignedUrl(statement.gst_invoice_path, 3600);

  if (signedError || !signedUrl) {
    return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
  }

  return NextResponse.json({
    data: {
      download_url: signedUrl.signedUrl,
      invoice_number: statement.gst_invoice_number,
      file_path: statement.gst_invoice_path,
    },
  });
}
