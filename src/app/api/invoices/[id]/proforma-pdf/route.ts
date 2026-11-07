import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { buildAdhocInvoicePdf } from "@/lib/adhoc-proforma-pdf";

export const maxDuration = 30;

/**
 * GET /api/invoices/[id]/proforma-pdf
 *
 * The ad-hoc proforma PDF for an invoice, in the same layout Receivables
 * downloads. Works before the invoice is sent (no billing statement yet) and
 * after (hands off to the statement's own builder). Read-only.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts", "office_admin", "sales_rep", "floor_manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const result = await buildAdhocInvoicePdf(await createAdminClient(), id);
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
