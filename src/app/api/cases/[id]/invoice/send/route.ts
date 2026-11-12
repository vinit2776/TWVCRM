import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { dispatchProforma } from "@/lib/send-proforma";

/**
 * POST /api/cases/[id]/invoice/send
 *
 * Confirms and dispatches a proforma_first VO case invoice that was created
 * with { preview: true } via POST /api/cases/[id]/invoice — i.e. the second
 * step of the "preview before send" flow. Also doubles as a resend if the
 * first dispatch attempt failed or the operator wants a fresh Razorpay link.
 *
 * Body: { cc?: string[] } — extra CC recipients on top of the case's
 * primary contact, passed straight through to dispatchProforma.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: caseId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  const ALLOWED_ROLES = ["admin", "manager", "sales_rep", "office_admin"];
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Not authorized to send case invoices" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as { cc?: string[] };
  const cc = Array.isArray(body.cc)
    ? body.cc.filter((e): e is string => typeof e === "string" && e.trim().length > 0)
    : [];

  const admin = createAdminClient();

  const { data: statement, error: fetchErr } = await admin
    .from("billing_statements")
    .select("id, voided_at")
    .eq("case_id", caseId)
    .eq("statement_type", "vo_case")
    .is("voided_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "No invoice found for this case — generate it first." }, { status: 404 });
  }

  const result = await dispatchProforma(admin, statement.id, dbUser.id, cc);

  if (!result.success) {
    return NextResponse.json({ error: result.error || "Failed to send invoice" }, { status: 500 });
  }

  return NextResponse.json({
    data: {
      emailed_to: result.emailedTo,
      no_contact: result.noContact,
      razorpay_link_url: result.razorpayLinkUrl,
    },
  });
}
