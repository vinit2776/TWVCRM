import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { enqueueTallyReceiptVoucher } from "@/lib/tally/enqueue";
import { isHandoffV2Enabled, handleStatementPaid } from "@/lib/tally-handoff-server";

/**
 * GET /api/billing-statements/[id]/payment — list payments for a statement
 * POST /api/billing-statements/[id]/payment — record a manual payment
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("billing_payments")
    .select("*, recorder:users!billing_payments_recorded_by_fkey(id, full_name)")
    .eq("billing_statement_id", id)
    .order("payment_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

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
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Only admin, manager, or accounts can record payments" }, { status: 403 });
  }

  const body = await request.json();
  const { amount, payment_date, payment_mode, payment_reference, proof_path, notes } = body;
  // TDS declared by the operator (never inferred). The cash received (amount) is
  // net; tds_amount is the customer's deduction. The statement settles on
  // (amount + tds_amount) so a TDS-short payment still closes the invoice.
  const tdsAmount  = Math.max(0, Number(body.tds_amount) || 0);
  const tdsSection = (typeof body.tds_section === "string" && body.tds_section.trim()) ? body.tds_section.trim() : null;

  if (!amount || amount <= 0) return NextResponse.json({ error: "Amount must be positive" }, { status: 400 });
  if (!payment_date) return NextResponse.json({ error: "Payment date is required" }, { status: 400 });
  if (!payment_mode) return NextResponse.json({ error: "Payment mode is required" }, { status: 400 });

  // Fetch statement to validate
  const { data: statement } = await supabase
    .from("billing_statements")
    .select("id, total_amount, status, payment_status")
    .eq("id", id)
    .single();

  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  if (statement.status === "draft") return NextResponse.json({ error: "Cannot record payment for a draft statement" }, { status: 400 });

  // Insert payment
  const { data: payment, error: insertErr } = await supabase
    .from("billing_payments")
    .insert({
      billing_statement_id: id,
      amount: Number(amount),
      payment_date,
      payment_mode,
      payment_reference: payment_reference || null,
      proof_path: proof_path || null,
      notes: notes || null,
      tds_amount: tdsAmount,
      tds_section: tdsSection,
      recorded_by: dbUser.id,
    })
    .select()
    .single();

  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  // Handoff v2: when the flag is on, the legacy bridge receipt-voucher
  // enqueue is bypassed. Accounts records the receipt in Tally directly,
  // and the read-only bridge verifies it on the next sync.
  const v2Enabled = await isHandoffV2Enabled(supabase);

  if (!v2Enabled) {
    // Legacy: reverse-sync the payment to Tally as a receipt voucher (closes the
    // loop so Tally's books reflect the offline payment). No-op unless this
    // statement's GST invoice was issued by Tally and sync is active.
    // Fire-and-forget. TDS, when declared, splits the Tally receipt:
    // bank (net) + TDS ledger + party (gross).
    void enqueueTallyReceiptVoucher(id, {
      paymentId:  payment.id,
      amount:     Number(amount),
      tdsAmount,
      tdsSection: tdsSection,
      date:       payment_date,
      mode:       payment_mode,
      reference:  payment_reference || null,
    });
  }

  // Check if fully paid. TDS counts toward settlement: cash + TDS = invoice.
  const { data: allPayments } = await supabase
    .from("billing_payments")
    .select("amount, tds_amount")
    .eq("billing_statement_id", id);

  const totalPaid = (allPayments || []).reduce((s, p) => s + Number(p.amount) + Number(p.tds_amount || 0), 0);
  const invoiceAmount = Number(statement.total_amount);

  let newPaymentStatus = "unpaid";
  if (totalPaid >= invoiceAmount) {
    newPaymentStatus = "paid";
  } else if (totalPaid > 0) {
    newPaymentStatus = "partially_paid";
  }

  if (newPaymentStatus !== statement.payment_status) {
    await supabase
      .from("billing_statements")
      .update({ payment_status: newPaymentStatus })
      .eq("id", id);
  }

  // When an offline payment brings the statement to fully paid:
  // - Legacy: auto-fire the GST tax invoice generation (CRM-side).
  // - v2: route to the accounts inbox via handoff_state; no CRM-side gen.
  if (newPaymentStatus === "paid" && statement.payment_status !== "paid") {
    if (v2Enabled) {
      await handleStatementPaid(supabase, id, "manual_payment_entry");
    } else {
      try {
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();
        fetch(`${appUrl}/api/billing-statements/${id}/generate-gst-invoice`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": process.env.CRON_SECRET || "",
          },
          body: JSON.stringify({ skipAuth: true }),
        }).catch((err) => console.error("[payment] GST invoice auto-gen failed:", err));
      } catch (err) {
        console.error("[payment] Could not trigger GST invoice generation:", err);
      }
    }
  }

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      payment_recorded: { old: null, new: `${payment_mode} ₹${amount} ref:${payment_reference || "—"}` },
      payment_status: { old: statement.payment_status, new: newPaymentStatus },
    },
  });

  return NextResponse.json({
    data: payment,
    payment_status: newPaymentStatus,
    total_paid: totalPaid,
    balance_due: Math.max(0, invoiceAmount - totalPaid),
  });
}
