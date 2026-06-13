import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const maxDuration = 30;

/**
 * GET /api/billing-statements/[id]/gst-invoice-pdf
 *
 * Streams the stored GST tax invoice PDF as a downloadable attachment.
 * Source resolution order:
 *   1. Tally handoff v2: latest non-superseded gst_invoice_uploads row
 *      (the PDF accounts uploaded from /accounting/inbox)
 *   2. Legacy: billing_statements.gst_invoice_path (CRM-generated era)
 *
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

  // ── Try v2 upload first ───────────────────────────────────────────────────
  const { data: upload } = await supabase
    .from("gst_invoice_uploads")
    .select("invoice_pdf_url, tally_invoice_number")
    .eq("billing_statement_id", id)
    .is("superseded_by", null)
    .order("uploaded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const storagePath = (upload?.invoice_pdf_url as string | undefined)
    ?? (statement.gst_invoice_path as string | null)
    ?? null;

  if (!storagePath) {
    return NextResponse.json(
      { error: "No GST invoice PDF available for this statement" },
      { status: 404 },
    );
  }

  // Stream PDF bytes directly so the browser downloads a real PDF, not JSON
  const adminSupabase = await createAdminClient();
  const { data: fileBlob, error: downloadErr } = await adminSupabase.storage
    .from("crm-documents")
    .download(storagePath);

  if (downloadErr || !fileBlob) {
    return NextResponse.json({ error: "Failed to retrieve GST invoice PDF" }, { status: 500 });
  }

  const pdfBuffer = Buffer.from(await fileBlob.arrayBuffer());
  const invoiceNum =
    (upload?.tally_invoice_number as string | undefined)
    ?? (statement.gst_invoice_number as string | null)
    ?? id.slice(0, 8);
  const filename = `GST-${invoiceNum.replace(/[\/]/g, "-")}.pdf`;

  return new NextResponse(pdfBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Content-Length": String(pdfBuffer.length),
    },
  });
}
