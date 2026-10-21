import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { computeProrataAmounts, prorataCorrectionBlocker } from "@/lib/prorata-correction";

/**
 * Corrects a renewal's pro-rata statement to the contract's CURRENT rate, in
 * place — same statement number, same Tally Inbox row. Used after the
 * contract's pricing was fixed (see /pricing-split) while the pro-rata invoice
 * was still waiting for accounts to issue.
 *
 * GET  — read-only preview: current vs corrected amounts and whether it is allowed.
 * POST — applies it. Admin only. Body: { reason, expected_total }, where
 *        expected_total is the corrected total the caller was shown; a mismatch
 *        (rate changed meanwhile) is refused.
 *
 * Neither verb sends anything to the customer or to accounts.
 */
type Ctx = { params: Promise<{ id: string }> };

async function load(id: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return { error: NextResponse.json({ error: "User not found" }, { status: 401 }) };
  if (dbUser.role !== "admin") {
    return { error: NextResponse.json({ error: "Only admin can correct a pro-rata statement" }, { status: 403 }) };
  }

  const admin = createAdminClient();
  const { data: contract } = await admin
    .from("contracts")
    .select("id, contract_number, start_date, subtotal, tax_percentage, prorata_billing_statement_id")
    .eq("id", id)
    .single();
  if (!contract) return { error: NextResponse.json({ error: "Contract not found" }, { status: 404 }) };
  if (!contract.prorata_billing_statement_id) {
    return { error: NextResponse.json({ error: "This contract has no pro-rata statement" }, { status: 400 }) };
  }

  const { data: stmt } = await admin
    .from("billing_statements")
    .select("*")
    .eq("id", contract.prorata_billing_statement_id)
    .single();
  if (!stmt || stmt.contract_id !== id) {
    return { error: NextResponse.json({ error: "Pro-rata statement not found" }, { status: 404 }) };
  }

  const [{ count: paymentsCount }, { count: liveUploadsCount }] = await Promise.all([
    admin.from("billing_payments").select("id", { count: "exact", head: true }).eq("billing_statement_id", stmt.id),
    admin.from("gst_invoice_uploads").select("id", { count: "exact", head: true })
      .eq("billing_statement_id", stmt.id).is("superseded_by", null),
  ]);

  const lines = (stmt.line_items ?? []) as Array<{ type?: string; items?: unknown[] }>;
  const blocker = prorataCorrectionBlocker({
    status: stmt.status,
    statementType: stmt.statement_type,
    paymentStatus: stmt.payment_status,
    paymentsCount: paymentsCount ?? 0,
    hasPaymentLink: Boolean(stmt.razorpay_payment_link_id || stmt.razorpay_payment_link_url),
    gstInvoiceNumber: stmt.gst_invoice_number,
    tallyInvoiceNumber: stmt.tally_invoice_number,
    issuanceChannel: stmt.issuance_channel,
    handoffState: stmt.handoff_state,
    liveUploadsCount: liveUploadsCount ?? 0,
    hasSingleProrataLine: lines.length === 1 && lines[0].type === "rent" && lines[0].items?.length === 1,
  });

  const corrected = computeProrataAmounts({
    monthlySubtotal: Number(contract.subtotal),
    startDate: contract.start_date,
    taxPercentage: Number(contract.tax_percentage || 18),
    isInterstate: Boolean(stmt.is_interstate),
  });

  return { supabase, admin, dbUser, contract, stmt, blocker, corrected };
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const r = await load(id);
  if (r.error) return r.error;
  const { stmt, blocker, corrected } = r;
  const differs = Math.abs(corrected.totalAmount - Number(stmt.total_amount)) >= 0.005;
  return NextResponse.json({
    data: {
      statement_id: stmt.id,
      statement_number: stmt.statement_number,
      current_total: Number(stmt.total_amount),
      corrected_total: corrected.totalAmount,
      corrected_subtotal: corrected.subtotal,
      corrected_tax: corrected.taxAmount,
      differs,
      eligible: differs && !blocker,
      blocker: differs ? blocker : null,
    },
  });
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { reason?: string; expected_total?: number };
  const reason = body.reason?.trim() ?? "";
  if (reason.length < 10) {
    return NextResponse.json({ error: "A reason of at least 10 characters is required" }, { status: 400 });
  }

  const r = await load(id);
  if (r.error) return r.error;
  const { admin, dbUser, contract, stmt, blocker, corrected } = r;

  if (blocker) return NextResponse.json({ error: blocker }, { status: 409 });
  if (Math.abs(corrected.totalAmount - Number(stmt.total_amount)) < 0.005) {
    return NextResponse.json({ error: "The statement already matches the contract rate" }, { status: 409 });
  }
  if (typeof body.expected_total !== "number" || Math.abs(body.expected_total - corrected.totalAmount) >= 0.005) {
    return NextResponse.json(
      { error: "The corrected amount changed since you reviewed it. Reload and check again.", corrected_total: corrected.totalAmount },
      { status: 409 }
    );
  }

  const oldLines = stmt.line_items as Array<{ items: Array<Record<string, unknown>> }>;
  const newLines = [{
    ...oldLines[0],
    items: [{
      ...oldLines[0].items[0],
      unit_price: corrected.subtotal,
      amount: corrected.subtotal,
      monthly_rate: Number(contract.subtotal),
    }],
    subtotal: corrected.subtotal,
  }];

  // Guarded on the values we validated so a concurrent change is not overwritten.
  const { data: updated, error } = await admin
    .from("billing_statements")
    .update({
      fixed_amount: corrected.subtotal,
      subtotal: corrected.subtotal,
      tax_amount: corrected.taxAmount,
      cgst_amount: corrected.cgstAmount,
      sgst_amount: corrected.sgstAmount,
      igst_amount: corrected.igstAmount,
      total_amount: corrected.totalAmount,
      line_items: newLines,
      updated_at: new Date().toISOString(),
    })
    .eq("id", stmt.id)
    .eq("total_amount", stmt.total_amount)
    .eq("status", stmt.status)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "The statement changed while saving. Reload and try again." }, { status: 409 });
  }

  logAudit(admin, {
    entityType: "billing_statement",
    entityId: stmt.id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      edit_reason: { old: null, new: `prorata_rate_correction: ${reason}` },
      subtotal: { old: Number(stmt.subtotal), new: corrected.subtotal },
      tax_amount: { old: Number(stmt.tax_amount), new: corrected.taxAmount },
      total_amount: { old: Number(stmt.total_amount), new: corrected.totalAmount },
    },
  });

  return NextResponse.json({ success: true, data: { total_amount: corrected.totalAmount } });
}
