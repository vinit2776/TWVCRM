import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/proposals/[id]/track
 *
 * Public endpoint — no auth required. Called when a customer clicks the
 * "Review Your Proposal" link in the proposal email.
 *
 * 1. Marks the proposal status as "viewed" (idempotent — only transitions from "sent")
 * 2. Sets viewed_at timestamp
 * 3. If a PDF storage path is recorded, generates a short-lived signed URL and
 *    redirects the customer straight to the PDF.
 * 4. If no PDF path is available, returns a simple branded confirmation page.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Admin client — public route, no session available
  const supabase = createAdminClient();

  const { data: proposal } = await supabase
    .from("proposals")
    .select("id, status, proposal_number, title, pdf_storage_path")
    .eq("id", id)
    .single();

  if (!proposal) {
    return new NextResponse("Proposal not found", { status: 404 });
  }

  // Advance status from "sent" → "viewed" (idempotent — don't overwrite later statuses)
  if (proposal.status === "sent") {
    await supabase
      .from("proposals")
      .update({ status: "viewed", viewed_at: new Date().toISOString() })
      .eq("id", id);
  }

  // If we have a stored PDF path, redirect the customer directly to the file
  if (proposal.pdf_storage_path) {
    const { data: signed } = await supabase.storage
      .from("crm-documents")
      .createSignedUrl(proposal.pdf_storage_path, 60 * 60); // 1 hour

    if (signed?.signedUrl) {
      return NextResponse.redirect(signed.signedUrl, { status: 302 });
    }
  }

  // Fallback: simple branded HTML confirmation page
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Proposal — The WorkVilla</title>
  <style>
    body { font-family: Arial, sans-serif; background: #f9fafb; display: flex;
           justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: white; border-radius: 12px; padding: 48px 40px; max-width: 480px;
            text-align: center; box-shadow: 0 2px 16px rgba(0,0,0,0.08); }
    .logo { color: #015E65; font-size: 22px; font-weight: bold; margin-bottom: 4px; }
    .sub  { color: #00AE6C; font-size: 12px; margin-bottom: 32px; }
    h2    { color: #111; font-size: 20px; margin: 0 0 12px; }
    p     { color: #555; font-size: 14px; line-height: 1.6; margin: 0 0 8px; }
    .num  { color: #015E65; font-weight: bold; }
    .cta  { margin-top: 32px; background: #015E65; color: white; border: none;
            border-radius: 8px; padding: 12px 28px; font-size: 14px; font-weight: 600;
            cursor: pointer; text-decoration: none; display: inline-block; }
    .footer { color: #aaa; font-size: 11px; margin-top: 32px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">The WorkVilla</div>
    <div class="sub">Empower your business with flexible workspaces</div>
    <h2>Thank you for reviewing your proposal</h2>
    <p>Proposal <span class="num">${proposal.proposal_number}</span> — <em>${proposal.title}</em></p>
    <p>Your proposal document is attached to the email you received. Our team will follow up with you shortly.</p>
    <p>If you have any questions, please reply to the email or call us at <strong>+91 97910 97900</strong>.</p>
    <div class="footer">© The WorkVilla · Sree Design Infrastructure Pvt Ltd</div>
  </div>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
