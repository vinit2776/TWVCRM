import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { dispatchProforma, dispatchGstDirect } from "@/lib/send-proforma";
import { handleStatementFinalized } from "@/lib/tally-handoff-server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/billing-statements/[id]/finalize-and-send
 *
 * Atomic combo used by the Usage tab on /billing. The operator reviews the
 * draft (adds / waives charges as needed) and clicks "Finalize & Send" —
 * one click does the lot:
 *
 *   1. Status → finalized
 *   2. Sets due_date = today (IST) + 7 days, if not already set
 *   3. Sets finalized_at
 *   4. Calls dispatchProforma() — generates Razorpay link, builds PDF,
 *      emails the customer, fires the WhatsApp template, stamps
 *      proforma_sent_at
 *
 * If dispatch fails, the status is rolled back to draft so the operator can
 * retry without the statement being "stuck" in finalized-but-not-sent limbo.
 *
 * Body: { additional_cc?: string[] } — optional extra emails for the
 *       dispatch (passed straight through to dispatchProforma).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin / Manager / Accounts access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as { additional_cc?: string[] };
  const additionalCc = Array.isArray(body.additional_cc) ? body.additional_cc.filter(Boolean) : [];

  const admin = createAdminClient();

  // Pull the statement to verify state before mutating.
  const { data: statement, error: fetchErr } = await admin
    .from("billing_statements")
    .select("id, status, voided_at, total_amount, due_date, statement_number, contract_id")
    .eq("id", id)
    .single();
  if (fetchErr || !statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  if (statement.voided_at) return NextResponse.json({ error: "Cannot finalize a voided statement" }, { status: 400 });
  if (statement.status !== "draft") {
    return NextResponse.json({ error: `Statement is already ${statement.status}` }, { status: 400 });
  }
  if (Number(statement.total_amount) <= 0) {
    return NextResponse.json({ error: "Cannot send a zero-amount statement — add charges or void instead" }, { status: 400 });
  }

  // 1. Flip to finalized, stamp finalized_at + due_date.
  const nowIso = new Date().toISOString();
  // Due date = today (IST) + 7 days.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  istNow.setUTCDate(istNow.getUTCDate() + 7);
  const dueDate = statement.due_date || istNow.toISOString().slice(0, 10);

  const { error: updateErr } = await admin
    .from("billing_statements")
    .update({ status: "finalized", finalized_at: nowIso, due_date: dueDate })
    .eq("id", id);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: "draft", new: "finalized" },
      due_date: { old: statement.due_date, new: dueDate },
    },
  });

  // 2. Dispatch. GST Direct contracts skip the PI and either issue a tax
  //    invoice directly or (v2 handoff) route to the Tally Inbox instead.
  //    If it fails, roll back to draft so the operator can fix the
  //    underlying issue (e.g. missing customer email) and retry.
  let billingMode: "proforma_first" | "gst_direct" | null = null;
  if (statement.contract_id) {
    const { data: contract } = await admin
      .from("contracts")
      .select("billing_mode")
      .eq("id", statement.contract_id)
      .single();
    billingMode = (contract?.billing_mode as "proforma_first" | "gst_direct" | null) ?? null;
  }
  const isGstDirect = billingMode === "gst_direct";

  const handoff = await handleStatementFinalized(admin, id, billingMode, "finalize_and_send");

  const dispatchResult = handoff.skipLegacyDispatch
    ? { success: true, noContact: false, emailedTo: null, razorpayLinkUrl: null, proformaRef: null, totalAmount: statement.total_amount, error: undefined }
    : isGstDirect
      ? await dispatchGstDirect(admin, id, dbUser.id, additionalCc)
      : await dispatchProforma(admin, id, dbUser.id, additionalCc);
  if (!dispatchResult.success) {
    await admin.from("billing_statements")
      .update({ status: "draft", finalized_at: null })
      .eq("id", id);
    logAudit(supabase, {
      entityType: "billing_statement",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: {
        status: { old: "finalized", new: "draft" },
        finalize_rollback_reason: { old: null, new: dispatchResult.error || "dispatch failed" },
      },
    });
    return NextResponse.json({
      error: `Finalize succeeded but dispatch failed (statement rolled back to draft): ${dispatchResult.error || "unknown"}`,
      rolled_back: true,
    }, { status: 502 });
  }

  return NextResponse.json({
    ok: true,
    statement_number: dispatchResult.proformaRef,
    total_amount: dispatchResult.totalAmount,
    due_date: dueDate,
    razorpay_link_url: dispatchResult.razorpayLinkUrl,
    emailed_to: dispatchResult.emailedTo,
    no_contact: dispatchResult.noContact,
  });
}
