import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/billing-statements/[id]/void
 *
 * Voids a finalized (or exported) billing statement and creates a fresh
 * draft copy so the operator can correct and re-issue.
 *
 * Guards:
 *   • Admin only
 *   • Blocked if any payments have been recorded against the statement
 *   • Statement must be finalized or exported (not draft or already voided)
 *
 * Side effects:
 *   • Cancels the proforma's Razorpay payment link, if one was issued —
 *     otherwise a client holding the emailed link could still pay a voided
 *     invoice. Best-effort; the payments webhook refuses to record against a
 *     voided statement as the second line of defence.
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
      { error: "Only admin can void billing statements" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({})) as { void_reason?: string };
  const voidReason = body.void_reason?.trim();

  if (!voidReason) {
    return NextResponse.json({ error: "A reason for voiding is required" }, { status: 400 });
  }

  // Fetch the statement
  const { data: statement, error: fetchErr } = await supabase
    .from("billing_statements")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !statement) {
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }

  // Only finalized or exported statements can be voided
  if (!["finalized", "exported"].includes(statement.status)) {
    return NextResponse.json(
      { error: `Cannot void a statement with status "${statement.status}". Only finalized or exported statements can be voided.` },
      { status: 400 }
    );
  }

  // D5: a Tally-issued GST invoice is on Tally's books (Tally = system of record).
  // Voiding it in the CRM alone would desync — Tally would still hold the invoice
  // and, for B2B, a live IRN with the IRP. Cancellation of a Tally invoice must go
  // through the CRM-first credit-note flow (Phase 1b), which instructs Tally to
  // reverse it before the CRM marks anything voided. Block the plain void here.
  if (statement.issuance_channel === "tally") {
    return NextResponse.json(
      {
        error: "This GST invoice was issued by Tally and cannot be voided from the CRM. Use the cancel/credit-note flow so Tally reverses it first, keeping the books in sync.",
        issuance_channel: "tally",
        tally_invoice_number: statement.tally_invoice_number ?? null,
      },
      { status: 409 }
    );
  }

  // Block if any payments have been recorded
  const { data: payments } = await supabase
    .from("billing_payments")
    .select("id, amount")
    .eq("billing_statement_id", id);

  if (payments && payments.length > 0) {
    const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0);
    return NextResponse.json(
      {
        error: `Cannot void — ₹${totalPaid.toLocaleString("en-IN")} in payments already recorded. Reverse or delete payments first.`,
        payments_count: payments.length,
        total_paid: totalPaid,
      },
      { status: 409 }
    );
  }

  const now = new Date().toISOString();

  // 1. Mark old statement as voided
  const { error: voidErr } = await supabase
    .from("billing_statements")
    .update({
      status: "voided",
      voided_at: now,
      voided_by: dbUser.id,
      void_reason: voidReason,
      notes: [
        statement.notes,
        `--- VOIDED ${new Date().toLocaleDateString("en-IN")} by admin ---`,
        `Reason: ${voidReason}`,
      ].filter(Boolean).join("\n"),
    })
    .eq("id", id);

  if (voidErr) {
    return NextResponse.json({ error: voidErr.message }, { status: 500 });
  }

  // 1b. Cancel the Razorpay payment link that went out with the proforma.
  //     Without this the client keeps a live, payable link for an invoice we
  //     have just cancelled. Best-effort — a link that is already paid,
  //     expired or cancelled fails here and that is not fatal (the void has
  //     already been committed, and the webhook guard covers the rest).
  //     razorpay_payment_link_id is deliberately left on the row so a stray
  //     webhook can still be traced back to this statement.
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
          console.warn("[statement void] Razorpay link cancel failed (non-fatal):", await cancelRes.text());
        }
      }
    } catch (e) {
      console.warn("[statement void] Razorpay cancel error (non-fatal):", e);
    }
  }

  // 2a. Un-link usage charges from the voided statement so they can be
  //     re-billed on the replacement draft
  await supabase
    .from("usage_charges")
    .update({ billing_statement_id: null, status: "pending" })
    .eq("billing_statement_id", id);

  // 2b. Un-link bookings from the voided statement so they re-appear
  //     as "unbilled" in the Contracts tab and can be picked up by the
  //     replacement draft statement
  await supabase
    .from("bookings")
    .update({ billing_statement_id: null })
    .eq("billing_statement_id", id);

  // 2c. Un-link service usage records (printer/service overages) so they are
  //     re-billable. Without this, service overages stay is_billed=true and the
  //     usage generator's `is_billed=false` filter skips them forever — silent
  //     revenue loss after a void.
  await supabase
    .from("service_usage_records")
    .update({ billing_statement_id: null, is_billed: false })
    .eq("billing_statement_id", id);

  // 2d. Un-link facility usage records — they carry their own
  //     billing_statement_id since 00563; left linked, a voided statement's
  //     facility overage would never bill again.
  await supabase
    .from("facility_usage_records")
    .update({ billing_statement_id: null })
    .eq("billing_statement_id", id);

  // 3. Create a fresh draft copy (carries over the billing-relevant data
  //    but strips out all finalization artifacts) — but only for
  //    contract/booking/lead-sourced statements. case_id/aggregator_id-owned
  //    statements (vo_case, vo_renewal, vo_aggregator_consolidated) have no
  //    "draft, then re-issue" concept: their generators (case-invoicing.ts,
  //    vo-renewal.ts, aggregator-invoicing.ts) create statements directly in
  //    a finalized state and already permit regeneration once voided_at is
  //    set, so leaving a leftover draft row here would (a) violate
  //    billing_statements_source_check, since none of contract_id/booking_id/
  //    lead_id are ever set on those statements, and (b) if case_id/
  //    aggregator_id were copied instead, poison the generators' own
  //    "does an active statement already exist" dedupe check (which only
  //    looks at voided_at, not status).
  const hasReissuableOwner = Boolean(
    statement.contract_id || statement.booking_id || statement.lead_id
  );

  let newStatement: { id: string; statement_number?: string | null } | null = null;

  if (hasReissuableOwner) {
    const { data: inserted, error: insertErr } = await supabase
      .from("billing_statements")
      .insert({
        contract_id: statement.contract_id,
        booking_id: statement.booking_id,
        lead_id: statement.lead_id,
        statement_type: statement.statement_type,
        period_start: statement.period_start,
        period_end: statement.period_end,
        accounting_period_id: statement.accounting_period_id,
        fixed_amount: statement.fixed_amount,
        usage_amount: statement.usage_amount,
        service_usage_amount: statement.service_usage_amount,
        booking_usage_amount: statement.booking_usage_amount,
        subtotal: statement.subtotal,
        tax_percentage: statement.tax_percentage,
        tax_amount: statement.tax_amount,
        total_amount: statement.total_amount,
        line_items: statement.line_items,
        prepaid_month: statement.prepaid_month,
        prepaid_year: statement.prepaid_year,
        // Keep the renewal attribution (00508): rent billed on a parent for a
        // renewal's period stays that renewal's on the re-issued copy too —
        // dropping it made the copy read as the parent's own rent.
        billed_on_behalf_of_contract_id: statement.billed_on_behalf_of_contract_id ?? null,
        status: "draft",
        notes: `Re-issued from voided ${statement.statement_number || statement.gst_invoice_number || id.slice(0, 8)}.\nOriginal void reason: ${voidReason}`,
        created_by: dbUser.id,
        voided_statement_id: id, // back-reference to the voided original
      })
      .select("*")
      .single();

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }

    newStatement = inserted;
  }

  // 4. Audit both operations
  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      status: { old: statement.status, new: "voided" },
      void_reason: { old: null, new: voidReason },
    },
  });

  if (newStatement) {
    logAudit(supabase, {
      entityType: "billing_statement",
      entityId: newStatement.id,
      action: "create",
      performedBy: dbUser.id,
      changes: {
        reissued_from: { old: null, new: id },
        status: { old: null, new: "draft" },
      },
    });
  }

  return NextResponse.json({
    voided_statement_id: id,
    new_statement: newStatement,
    message: newStatement
      ? `Statement voided. New draft ${newStatement.statement_number || newStatement.id.slice(0, 8)} created.`
      : "Statement voided. Generate a new invoice for this case/aggregator when ready.",
  });
}
