import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { dispatchProforma } from "@/lib/send-proforma";

export const maxDuration = 30;

/**
 * POST /api/billing-statements/[id]/send-proforma
 *
 * Thin auth wrapper over dispatchProforma() in src/lib/send-proforma.ts.
 * The actual Razorpay link creation, PDF generation, and email/WhatsApp
 * dispatch all live in that shared library so the billing cron can call
 * them directly without making HTTP self-calls.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const adminSupabase = await createAdminClient();

  let dbUserId: string | null = null;

  // Internal/cron calls authenticate with x-internal-secret + skipAuth (no session).
  // Keeps the route callable by background jobs that dispatch proformas server-side.
  const isInternalCall =
    body.skipAuth === true &&
    request.headers.get("x-internal-secret") === process.env.CRON_SECRET;

  if (!isInternalCall) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: dbUser } = await supabase
      .from("users").select("id, role").eq("auth_id", user.id).single();
    if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
      return NextResponse.json(
        { error: "Only admin, manager, or accounts can send proforma invoices" },
        { status: 403 }
      );
    }
    dbUserId = dbUser.id;
  }

  // Validate statement is ready to send
  const { data: stmt } = await adminSupabase
    .from("billing_statements")
    .select("status, voided_at")
    .eq("id", id)
    .single();

  if (!stmt) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  if (stmt.status === "draft") return NextResponse.json({ error: "Finalize the statement before sending a proforma" }, { status: 400 });
  if (stmt.voided_at) return NextResponse.json({ error: "Statement is voided" }, { status: 400 });

  const additionalCc: string[] = Array.isArray(body.cc) ? (body.cc as string[]).filter(Boolean) : [];

  const result = await dispatchProforma(adminSupabase, id, dbUserId, additionalCc);

  if (!result.success) {
    return NextResponse.json({ error: result.error || "Dispatch failed" }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    proformaRef: result.proformaRef,
    totalAmount: result.totalAmount,
    razorpayLinkUrl: result.razorpayLinkUrl,
    emailedTo: result.emailedTo,
    emailSkipped: result.emailSkipped,
    noContact: result.noContact,
  });
}
