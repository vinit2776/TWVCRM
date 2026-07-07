import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { dispatchProforma, dispatchGstDirect } from "@/lib/send-proforma";

export const maxDuration = 30;

/**
 * POST /api/billing-statements/[id]/send-proforma
 *
 * Thin auth wrapper over dispatchProforma() / dispatchGstDirect() in
 * src/lib/send-proforma.ts. Checks the contract's billing_mode:
 *   proforma_first (default) → dispatchProforma()
 *   gst_direct               → dispatchGstDirect() — skips PI, issues tax invoice
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
        { error: "Only admin, manager, or accounts can send invoices" },
        { status: 403 }
      );
    }
    dbUserId = dbUser.id;
  }

  // Validate statement is ready to send + fetch billing_mode from contract
  const { data: stmt } = await adminSupabase
    .from("billing_statements")
    .select("status, voided_at, contract_id")
    .eq("id", id)
    .single();

  if (!stmt) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  if (stmt.status === "draft") return NextResponse.json({ error: "Finalize the statement before sending" }, { status: 400 });
  if (stmt.voided_at) return NextResponse.json({ error: "Statement is voided" }, { status: 400 });

  // Fetch billing_mode from the linked contract
  let billingMode = "proforma_first";
  if (stmt.contract_id) {
    const { data: contract } = await adminSupabase
      .from("contracts")
      .select("billing_mode")
      .eq("id", stmt.contract_id)
      .single();
    billingMode = (contract?.billing_mode as string | null) || "proforma_first";
  }

  const additionalCc: string[] = Array.isArray(body.cc) ? (body.cc as string[]).filter(Boolean) : [];
  const toOverride: string[] = Array.isArray(body.to) ? (body.to as string[]).filter(Boolean) : [];

  const result = billingMode === "gst_direct"
    ? await dispatchGstDirect(adminSupabase, id, dbUserId, additionalCc, toOverride)
    : await dispatchProforma(adminSupabase, id, dbUserId, additionalCc, toOverride);

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
