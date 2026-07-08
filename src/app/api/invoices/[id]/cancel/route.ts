import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * POST /api/invoices/[id]/cancel
 *
 * Cancels an ad-hoc lead invoice (proforma_invoices). Blocked once the
 * invoice (or its linked billing_statements row) has a payment recorded —
 * a paid invoice needs a credit note process, not a cancel.
 *
 * Side effects:
 *   - Cancels the Razorpay payment link, if one exists (best-effort —
 *     an already-expired/paid link failing to cancel is not fatal).
 *   - Voids the linked billing_statements row (if one exists — i.e. the
 *     invoice was actually emailed), so it drops out of Accounts
 *     Receivable and stops being dunned by the reminder cron.
 *
 * Body (JSON): { reason?: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id").eq("auth_id", user.id).single();

  const body = await request.json().catch(() => ({}));
  const reason = (body.reason as string | undefined)?.trim() || null;

  const { data: invoice } = await supabase
    .from("proforma_invoices")
    .select("id, invoice_number, status, notes, razorpay_link_id")
    .eq("id", id)
    .single();

  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (invoice.status === "cancelled") {
    return NextResponse.json({ error: "Invoice is already cancelled" }, { status: 400 });
  }
  if (invoice.status === "paid") {
    return NextResponse.json({ error: "Cannot cancel a paid invoice" }, { status: 400 });
  }

  const adminSupabase = createAdminClient();

  // Defensively re-check the linked statement's payment status independently —
  // it could in principle have a payment recorded via the generic
  // /api/billing-statements/[id]/payment route without proforma_invoices.status
  // having been updated to "paid" first.
  const { data: statement } = await adminSupabase
    .from("billing_statements")
    .select("id, payment_status, voided_at")
    .eq("invoice_id", id)
    .maybeSingle();

  if (statement && statement.payment_status === "paid") {
    return NextResponse.json({ error: "Linked billing statement already has a payment recorded — cannot cancel" }, { status: 400 });
  }

  // ── Cancel the Razorpay payment link (best-effort) ──────────────────────
  if (invoice.razorpay_link_id) {
    try {
      const { data: rzpSettings } = await adminSupabase
        .from("app_settings")
        .select("key, value")
        .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
      const rzpMap: Record<string, string> = {};
      (rzpSettings || []).forEach((s) => { rzpMap[s.key] = s.value; });

      if (rzpMap.razorpay_enabled === "true" && rzpMap.razorpay_key_id && rzpMap.razorpay_key_secret) {
        const auth = Buffer.from(`${rzpMap.razorpay_key_id}:${rzpMap.razorpay_key_secret}`).toString("base64");
        const cancelRes = await fetch(`https://api.razorpay.com/v1/payment_links/${invoice.razorpay_link_id}/cancel`, {
          method: "POST",
          headers: { Authorization: `Basic ${auth}` },
        });
        if (!cancelRes.ok) {
          console.warn("[invoice cancel] Razorpay link cancel failed (non-fatal):", await cancelRes.text());
        }
      }
    } catch (e) {
      console.warn("[invoice cancel] Razorpay cancel error (non-fatal):", e);
    }
  }

  // ── Cancel the invoice ───────────────────────────────────────────────────
  const now = new Date().toISOString();
  const updatedNotes = reason
    ? `${invoice.notes ? invoice.notes + "\n" : ""}Cancelled: ${reason}`
    : invoice.notes;

  const { error: updateErr } = await supabase
    .from("proforma_invoices")
    .update({ status: "cancelled", notes: updatedNotes })
    .eq("id", id);

  if (updateErr) {
    return NextResponse.json({ error: "Failed to cancel invoice" }, { status: 500 });
  }

  // ── Void the linked billing_statements row, if any ──────────────────────
  if (statement && !statement.voided_at) {
    await adminSupabase
      .from("billing_statements")
      .update({
        status: "voided",
        voided_at: now,
        voided_by: dbUser?.id || null,
        void_reason: reason || `Ad-hoc invoice ${invoice.invoice_number} cancelled`,
      })
      .eq("id", statement.id);
  }

  return NextResponse.json({ success: true });
}
