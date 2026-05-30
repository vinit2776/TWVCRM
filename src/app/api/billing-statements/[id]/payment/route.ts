import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";

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
      recorded_by: dbUser.id,
    })
    .select()
    .single();

  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  // Check if fully paid
  const { data: allPayments } = await supabase
    .from("billing_payments")
    .select("amount")
    .eq("billing_statement_id", id);

  const totalPaid = (allPayments || []).reduce((s, p) => s + Number(p.amount), 0);
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

  // When an offline payment brings the statement to fully paid, auto-fire the
  // GST tax invoice generation — same behaviour as the Razorpay webhook. Saves
  // accounts the extra "Generate GST Invoice" click and prevents the
  // proforma-paid-but-no-tax-invoice limbo state.
  if (newPaymentStatus === "paid" && statement.payment_status !== "paid") {
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
