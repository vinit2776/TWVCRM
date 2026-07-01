import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/billing-statements/[id]/track?type=proforma|gst
 *
 * Public endpoint — no auth required. Embedded in client-facing invoice emails.
 *
 * type=proforma  — called when a proforma_first client clicks "View Invoice"
 *                  Sets proforma_viewed_at (idempotent), redirects to proforma PDF.
 *
 * type=gst       — called when a gst_direct client clicks "View Invoice"
 *                  Sets gst_invoice_viewed_at (idempotent), redirects to GST invoice PDF.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const type = request.nextUrl.searchParams.get("type") ?? "proforma";

  const supabase = createAdminClient();

  const { data: statement } = await supabase
    .from("billing_statements")
    .select("id, statement_number, proforma_sent_at, gst_invoice_number, gst_invoice_path, proforma_viewed_at, gst_invoice_viewed_at, status")
    .eq("id", id)
    .single();

  if (!statement) {
    return new NextResponse("Invoice not found", { status: 404 });
  }

  let storagePath: string | null = null;

  if (type === "gst") {
    if (!statement.gst_invoice_number) {
      return new NextResponse("GST invoice not yet issued", { status: 400 });
    }
    if (!statement.gst_invoice_viewed_at) {
      await supabase
        .from("billing_statements")
        .update({ gst_invoice_viewed_at: new Date().toISOString() })
        .eq("id", id)
        .is("gst_invoice_viewed_at", null);
    }
    storagePath = (statement.gst_invoice_path as string | null) ?? null;
  } else {
    if (!statement.proforma_sent_at) {
      return new NextResponse("Proforma invoice not yet sent", { status: 400 });
    }
    if (!statement.proforma_viewed_at) {
      await supabase
        .from("billing_statements")
        .update({ proforma_viewed_at: new Date().toISOString() })
        .eq("id", id)
        .is("proforma_viewed_at", null);
    }
    const ref = (statement.statement_number as string).replace(/\//g, "-");
    storagePath = `proforma/${ref}.pdf`;
  }

  if (storagePath) {
    const { data: signed } = await supabase.storage
      .from("crm-documents")
      .createSignedUrl(storagePath, 60 * 60);

    if (signed?.signedUrl) {
      return NextResponse.redirect(signed.signedUrl, { status: 302 });
    }
  }

  // Fallback branded page when PDF is unavailable
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invoice — The WorkVilla</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f9fafb; display: flex;
           justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: white; border-radius: 12px; padding: 48px 40px; max-width: 480px;
            text-align: center; box-shadow: 0 2px 16px rgba(0,0,0,0.08); }
    .logo { color: #015E65; font-size: 22px; font-weight: bold; margin-bottom: 4px; }
    .sub  { color: #00AE6C; font-size: 12px; margin-bottom: 32px; }
    h2    { color: #111; font-size: 20px; margin: 0 0 12px; }
    p     { color: #555; font-size: 14px; line-height: 1.6; margin: 0 0 8px; }
    .footer { color: #aaa; font-size: 11px; margin-top: 32px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">The WorkVilla</div>
    <div class="sub">Empower your business with flexible workspaces</div>
    <h2>Your invoice has been received</h2>
    <p>The invoice PDF is attached to the email you received.</p>
    <p>For any questions, reply to the email or call <strong>+91 97910 97900</strong>.</p>
    <div class="footer">© The WorkVilla · Sree Design Infrastructure Pvt Ltd</div>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
