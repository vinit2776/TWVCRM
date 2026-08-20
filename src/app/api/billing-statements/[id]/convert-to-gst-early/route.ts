import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { setHandoffState } from "@/lib/tally-handoff-server";
import { z } from "zod";

export const maxDuration = 30;

const BodySchema = z.object({
  reason: z.string().min(5, "Reason must be at least 5 characters"),
});

const RAZORPAY_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * POST /api/billing-statements/[id]/convert-to-gst-early
 *
 * Overrides the standard proforma-first flow: cancels the existing PI (proforma)
 * and queues the statement to the Tally inbox so accounts can create and upload
 * the GST invoice manually.
 *
 * The Razorpay payment link and customer email are created/sent by
 * POST /api/billing-statements/[id]/upload-gst-invoice once the invoice is uploaded
 * and the name check passes (handoff_state → ready_to_send).
 *
 * Guards:
 *   - Admin or manager only
 *   - Statement must be finalized, unpaid/partially paid, no existing GST invoice
 *   - PI must not already have been cancelled via this action
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
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin or manager can issue an early GST invoice override" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid request" }, { status: 400 });
  }
  const { reason } = parsed.data;

  const adminSupabase = await createAdminClient();

  const { data: statement, error: fetchErr } = await adminSupabase
    .from("billing_statements")
    .select(`
      id, status, payment_status, gst_invoice_number, pi_cancelled_at,
      statement_number, razorpay_payment_link_id, notes, due_date, reminder_count,
      contract:contracts!billing_statements_contract_id_fkey(id, contract_number)
    `)
    .eq("id", id)
    .single();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  // Guards
  if (statement.status !== "finalized") {
    return NextResponse.json({ error: "Statement must be finalized to use this override" }, { status: 400 });
  }
  if (statement.payment_status === "paid") {
    return NextResponse.json({ error: "Statement is already fully paid — use the standard GST invoice flow" }, { status: 400 });
  }
  if (statement.gst_invoice_number) {
    return NextResponse.json({ error: "A GST invoice has already been issued for this statement", invoiceNumber: statement.gst_invoice_number }, { status: 409 });
  }
  if (statement.pi_cancelled_at) {
    return NextResponse.json({ error: "PI has already been cancelled via an earlier override" }, { status: 409 });
  }

  // ── Fetch Razorpay credentials ──────────────────────────────────────────
  const { data: rzpRows } = await adminSupabase
    .from("app_settings").select("key, value")
    .in("key", ["razorpay_enabled", "razorpay_key_id", "razorpay_key_secret"]);
  const rzp = (rzpRows || []).reduce((m: Record<string, string>, r: { key: string; value: string }) => {
    m[r.key] = r.value; return m;
  }, {});
  const rzpEnabled = rzp.razorpay_enabled === "true" && !!rzp.razorpay_key_id && !!rzp.razorpay_key_secret;
  const rzpAuth = rzpEnabled
    ? Buffer.from(`${rzp.razorpay_key_id}:${rzp.razorpay_key_secret}`).toString("base64")
    : null;

  // ── Cancel existing Razorpay payment link ───────────────────────────────
  const existingLinkId = statement.razorpay_payment_link_id as string | null;
  if (existingLinkId && rzpAuth) {
    try {
      await withTimeout(
        fetch(`https://api.razorpay.com/v1/payment_links/${existingLinkId}/cancel`, {
          method: "POST",
          headers: { Authorization: `Basic ${rzpAuth}` },
        }),
        RAZORPAY_TIMEOUT_MS,
        "Razorpay cancel link",
      );
    } catch (err) {
      console.error("[convert-to-gst-early] Razorpay cancel failed (non-blocking):", err);
    }
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const nowYmd = nowIso.slice(0, 10);

  // ── Record PI cancellation ────────────────────────────────────────────────
  await adminSupabase.from("billing_statements").update({
    pi_cancelled_at: nowIso,
    pi_cancelled_by: dbUser.id,
    pi_override_reason: reason,
    razorpay_payment_link_id: null,
    razorpay_payment_link_url: null,
    due_date: nowYmd,
    // Moving due_date forward restarts the dunning clock, so the reminder
    // ladder has to restart with it. The cron picks a stage from days-overdue
    // against due_date but gates it on reminder_count; leaving a stale count
    // behind a fresh due date makes every already-fired stage read as "stage
    // already sent" and the statement goes silent until days-overdue catches
    // back up — weeks, on a ladder that runs to day 30. See TWV-BS-0167 and
    // TWV-BS-0149, which went quiet for 29 and 35 days respectively.
    reminder_count: 0,
    last_reminder_sent_at: null,
    notes: [
      statement.notes,
      `PI ${statement.statement_number} cancelled ${nowYmd} — early GST invoice queued to Tally inbox. Reason: ${reason}`,
    ].filter(Boolean).join("\n"),
  }).eq("id", id);

  // ── Queue to Tally inbox ──────────────────────────────────────────────────
  // handoff_state = direct_gst_requested puts the row in the "GST to issue"
  // bucket on the accounts inbox. The upload route handles Razorpay + email.
  await setHandoffState(adminSupabase, id, "direct_gst_requested", "convert_to_gst_early");

  logAudit(adminSupabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      pi_cancelled_at: { old: null, new: nowIso },
      handoff_state: { old: null, new: "direct_gst_requested" },
      due_date: { old: statement.due_date, new: nowYmd },
      reminder_count: { old: statement.reminder_count ?? 0, new: 0 },
      razorpay_payment_link_id: { old: existingLinkId, new: null },
      override_reason: { old: null, new: reason },
    },
  });

  return NextResponse.json({
    success: true,
    queuedToInbox: true,
  });
}
