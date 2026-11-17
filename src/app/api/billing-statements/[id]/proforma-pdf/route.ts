import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { buildProformaPdf } from "@/lib/proforma-pdf";

export const maxDuration = 30;

/**
 * GET /api/billing-statements/[id]/proforma-pdf
 *
 * Returns the proforma invoice as a downloadable PDF.
 * Rebuilds the PDF on-the-fly using stored statement data.
 * Includes QR code if a Razorpay payment link exists.
 *
 * ?preview=1 additionally allows this on a DRAFT statement — used by the
 * Generate & Send review row to show "exactly what the customer will get"
 * before Finalize & Send. Still read-only (no mutation, no email, no
 * Razorpay call); a draft has no payment link yet, so the preview simply
 * renders without the Pay Now / QR section, same as a real send would look
 * before that link exists.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const isPreview = req.nextUrl.searchParams.get("preview") === "1";

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts", "office_admin", "sales_rep"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const adminSupabase = await createAdminClient();

  const result = await buildProformaPdf(adminSupabase, id, { preview: isPreview });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });

  return new NextResponse(new Uint8Array(result.buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${result.filename}"`,
      "Content-Length": String(result.buffer.length),
    },
  });
}
