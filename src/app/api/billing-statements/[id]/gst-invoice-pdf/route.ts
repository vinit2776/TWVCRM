import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const maxDuration = 30;

/**
 * GET /api/billing-statements/[id]/gst-invoice-pdf
 *
 * Streams the stored GST tax invoice PDF as a downloadable attachment.
 * Uses the admin client to access the private storage bucket.
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

  // Stream PDF bytes directly so the browser downloads a real PDF, not JSON
  const adminSupabase = await createAdminClient();
  const { data: fileBlob, error: downloadErr } = await adminSupabase.storage
    .from("crm-documents")
    .download(statement.gst_invoice_path);

  if (downloadErr || !fileBlob) {
    return NextResponse.json({ error: "Failed to retrieve GST invoice PDF" }, { status: 500 });
  }

  const pdfBuffer = Buffer.from(await fileBlob.arrayBuffer());
  const invoiceNum = (statement.gst_invoice_number as string | null) ?? id.slice(0, 8);
  const filename = `GST-${invoiceNum.replace(/\//g, "-")}.pdf`;

  return new NextResponse(pdfBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}
