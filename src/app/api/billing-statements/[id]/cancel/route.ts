import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { canCancelInvoice, classifyForCancel } from "@/lib/invoice-cancel";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";

/**
 * POST /api/billing-statements/[id]/cancel
 *
 * Cancels a proforma invoice (PI) from Accounts Receivable: reminders stop,
 * the payment link is killed and the PI leaves the receivables list. Nothing
 * is sent to the customer. Unlike /void, no replacement draft is created —
 * the person asked for it to go away, not to be corrected and re-issued.
 *
 * Roles: admin, manager. Accounts cannot cancel.
 * Blocked when any payment is recorded (reverse it first).
 *
 * A Tally-issued GST invoice cannot just be voided — Accounts must issue a
 * credit note in Tally. For those this route only *requests* the cancellation:
 * reminders stop, the payment link is cancelled, and a task appears in the
 * Tally Inbox. The invoice is voided later by upload-credit-note.
 *
 * Body (JSON): { reason: string } — at least 10 characters, audited.
 */
export const dynamic = "force-dynamic";

/** Best-effort: a link that is already expired/paid fails here and that is
 *  fine — the payments webhook also refuses voided statements. */
async function cancelPaymentLink(admin: ReturnType<typeof createAdminClient>, linkId: string | null) {
  if (!linkId) return;
  try {
    const { data: rzpSettings } = await admin
      .from("app_settings").select("key, value")
      .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
    const rzp: Record<string, string> = {};
    (rzpSettings || []).forEach((r: { key: string; value: string }) => { rzp[r.key] = r.value; });
    if (rzp.razorpay_enabled === "true" && rzp.razorpay_key_id && rzp.razorpay_key_secret) {
      const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");
      const res = await fetch(
        `https://api.razorpay.com/v1/payment_links/${linkId}/cancel`,
        { method: "POST", headers: { Authorization: `Basic ${auth}` } },
      );
      if (!res.ok) console.warn("[statement cancel] Razorpay link cancel failed (non-fatal)");
    }
  } catch {
    console.warn("[statement cancel] Razorpay cancel error (non-fatal)");
  }
}

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
  if (!dbUser || !canCancelInvoice(dbUser.role)) {
    return NextResponse.json({ error: "Only admin or manager can cancel an invoice" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as { reason?: string };
  const reason = body.reason?.trim() ?? "";
  if (reason.length < 10) {
    return NextResponse.json({ error: "Please give a reason (at least 10 characters)" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: statement } = await admin
    .from("billing_statements")
    .select(
      "id, status, payment_status, voided_at, statement_number, notes, gst_invoice_number, tally_invoice_number, " +
      "issuance_channel, cancellation_requested_at, statement_number, proposal_id, case_id, aggregator_id, invoice_id, razorpay_payment_link_id",
    )
    .eq("id", id)
    .maybeSingle();
  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- select() string is dynamic, so the row type is untyped
  const s = statement as any;
  const verdict = classifyForCancel(s);
  if (verdict.kind !== "pi" && verdict.kind !== "gst") {
    return NextResponse.json({ error: verdict.reason }, { status: 409 });
  }

  const { count: paymentCount } = await admin
    .from("billing_payments")
    .select("id", { count: "exact", head: true })
    .eq("billing_statement_id", id);
  if ((paymentCount ?? 0) > 0) {
    return NextResponse.json(
      { error: "A payment is already recorded on this invoice. Reverse it first, then cancel." },
      { status: 409 },
    );
  }

  if (verdict.kind === "gst") {
    const { error: reqErr } = await admin
      .from("billing_statements")
      .update({
        cancellation_requested_at: new Date().toISOString(),
        cancellation_requested_by: dbUser.id,
        cancellation_reason: reason,
      })
      .eq("id", id)
      .is("cancellation_requested_at", null)
      .is("voided_at", null);
    if (reqErr) return NextResponse.json({ error: reqErr.message }, { status: 500 });

    await cancelPaymentLink(admin, s.razorpay_payment_link_id);

    // Tell Accounts there is a credit note to issue. Failure to notify must
    // not undo the request — the Tally Inbox lists it either way.
    try {
      const { data: accounts } = await admin.from("users").select("id").eq("role", "accounts").eq("is_active", true);
      await createNotificationsForUsers((accounts || []).map((u: { id: string }) => u.id), {
        type: "invoice_cancellation_requested",
        title: `Credit note needed: ${s.tally_invoice_number}`,
        body: `${s.statement_number} must be cancelled. Reason: ${reason}`,
        url: "/accounting/inbox",
        entityType: "billing_statement",
        entityId: id,
      });
    } catch {
      console.warn("[statement cancel] accounts notification failed (non-fatal)");
    }

    logAudit(supabase, {
      entityType: "billing_statement",
      entityId: id,
      action: "update",
      performedBy: dbUser.id,
      changes: { cancellation_requested: { old: null, new: reason } },
    });
    return NextResponse.json({ success: true, requested: true });
  }

  const now = new Date().toISOString();
  const { error: updErr } = await admin
    .from("billing_statements")
    .update({
      status: "voided",
      lifecycle_stage: "cancelled",
      voided_at: now,
      voided_by: dbUser.id,
      void_reason: reason,
      notes: [s.notes, `--- CANCELLED ${new Date().toLocaleDateString("en-IN")} ---`, `Reason: ${reason}`]
        .filter(Boolean).join("\n"),
    })
    .eq("id", id)
    .is("voided_at", null);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  await cancelPaymentLink(admin, s.razorpay_payment_link_id);

  // Release usage so it can be billed again (same four tables void releases;
  // missing one silently loses revenue).
  const released: Record<string, number> = {};
  const release = async (table: string, patch: Record<string, unknown>) => {
    const { data } = await admin.from(table).update(patch).eq("billing_statement_id", id).select("id");
    released[table] = data?.length ?? 0;
  };
  await release("usage_charges", { billing_statement_id: null, status: "pending" });
  await release("bookings", { billing_statement_id: null });
  await release("service_usage_records", { billing_statement_id: null, is_billed: false });
  await release("facility_usage_records", { billing_statement_id: null });

  // An ad-hoc invoice carries its own status; keep it in step.
  if (s.invoice_id) {
    await admin.from("proforma_invoices").update({ status: "cancelled" }).eq("id", s.invoice_id).neq("status", "paid");
  }

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: s.status, new: "voided" },
      cancel_reason: { old: null, new: reason },
      ...(Object.values(released).some((n) => n > 0) ? { released_usage: { old: null, new: released } } : {}),
    },
  });

  return NextResponse.json({ success: true });
}
