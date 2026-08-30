import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { totalPaid, balanceDue } from "@/lib/settlement";

/**
 * POST /api/billing-statements/[id]/write-off
 *
 * Marks a correctly-issued statement as an uncollectible bad debt so it stops
 * showing up on Accounts Receivable, without touching the document itself.
 *
 * This is deliberately NOT a variant of void. Void assumes the invoice was
 * wrong: it un-links usage_charges/bookings/service_usage_records back to
 * unbilled and creates a fresh draft with the same amounts, so the same
 * charge gets billed again next cycle. That's the wrong shape for a real,
 * correctly-billed invoice the customer simply can't or won't pay — voiding
 * it would just regenerate the same receivable. Write-off leaves the billed
 * data, the GST invoice number and any Tally record exactly as issued; only
 * payment_status changes, which is also all that's needed for it to drop out
 * of the receivables feed (src/app/api/accounting/receivables/route.ts
 * already filters to payment_status in unpaid/partially_paid).
 *
 * GST/Tally are intentionally out of scope: output tax on an issued invoice
 * is owed on supply, not on payment received, so a customer default is not
 * grounds to reverse it. If a specific case needs a credit note, that stays
 * the existing separate credit-note flow — this route never touches
 * gst_invoice_number, tally_invoice_number or issuance_channel.
 *
 * Guards:
 *   • Admin only
 *   • Statement must be finalized or exported
 *   • payment_status must be unpaid or partially_paid (not already paid or
 *     already written off — this action is final, not idempotent)
 *
 * Side effects:
 *   • Cancels the proforma's Razorpay payment link, if one was issued —
 *     no reason to leave a payable link open on a debt just declared
 *     uncollectible. Best-effort, same as void.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only admin can write off billing statements" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({})) as { write_off_reason?: string };
  const writeOffReason = body.write_off_reason?.trim();

  if (!writeOffReason) {
    return NextResponse.json({ error: "A reason for writing off is required" }, { status: 400 });
  }

  const { data: statement, error: fetchErr } = await supabase
    .from("billing_statements")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  if (!["finalized", "exported"].includes(statement.status)) {
    return NextResponse.json(
      { error: `Cannot write off a statement with status "${statement.status}". Only finalized or exported statements can be written off.` },
      { status: 400 }
    );
  }

  if (statement.payment_status === "written_off") {
    return NextResponse.json({ error: "This statement has already been written off." }, { status: 409 });
  }

  if (statement.payment_status === "paid") {
    return NextResponse.json({ error: "This statement is already fully paid — there is no balance to write off." }, { status: 409 });
  }

  // Same settlement math as the receivables page and the payment route —
  // never hand-roll this sum.
  const { data: payments } = await supabase
    .from("billing_payments")
    .select("amount, tds_amount")
    .eq("billing_statement_id", id);

  const paidToDate = totalPaid(payments);
  const writeOffAmount = balanceDue(statement.total_amount, paidToDate);

  if (writeOffAmount <= 0) {
    return NextResponse.json({ error: "There is no outstanding balance on this statement to write off." }, { status: 409 });
  }

  const now = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from("billing_statements")
    .update({
      payment_status: "written_off",
      written_off_at: now,
      written_off_by: dbUser.id,
      write_off_reason: writeOffReason,
      written_off_amount: writeOffAmount,
      notes: [
        statement.notes,
        `--- WRITTEN OFF ${new Date().toLocaleDateString("en-IN")} by admin (₹${writeOffAmount.toLocaleString("en-IN")}) ---`,
        `Reason: ${writeOffReason}`,
      ].filter(Boolean).join("\n"),
    })
    .eq("id", id);

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Cancel a live Razorpay payment link, if any — best-effort, mirrors void.
  const linkId = statement.razorpay_payment_link_id as string | null;
  if (linkId) {
    try {
      const adminSupabase = createAdminClient();
      const { data: rzpSettings } = await adminSupabase
        .from("app_settings")
        .select("key, value")
        .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
      const rzp: Record<string, string> = {};
      (rzpSettings || []).forEach((s: { key: string; value: string }) => { rzp[s.key] = s.value; });

      if (rzp.razorpay_enabled === "true" && rzp.razorpay_key_id && rzp.razorpay_key_secret) {
        const auth = Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64");
        const cancelRes = await fetch(
          `https://api.razorpay.com/v1/payment_links/${linkId}/cancel`,
          { method: "POST", headers: { Authorization: `Basic ${auth}` } }
        );
        if (!cancelRes.ok) {
          console.warn("[statement write-off] Razorpay link cancel failed (non-fatal):", await cancelRes.text());
        }
      }
    } catch (e) {
      console.warn("[statement write-off] Razorpay cancel error (non-fatal):", e);
    }
  }

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      payment_status: { old: statement.payment_status, new: "written_off" },
      write_off_reason: { old: null, new: writeOffReason },
      written_off_amount: { old: null, new: writeOffAmount },
    },
  });

  return NextResponse.json({
    written_off_amount: writeOffAmount,
    message: `Statement written off. ₹${writeOffAmount.toLocaleString("en-IN")} removed from Accounts Receivable.`,
  });
}
