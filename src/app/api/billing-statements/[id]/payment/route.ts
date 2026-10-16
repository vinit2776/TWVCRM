import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { enqueueTallyReceiptVoucher } from "@/lib/tally/enqueue";
import { isHandoffV2Enabled } from "@/lib/tally-handoff-server";
import { finalizeBillingPayment } from "@/lib/billing-payment-settlement";
import { canRecordPayments } from "@/lib/constants";
import { OVERPAYMENT_CODE, overpaymentMessage } from "@/lib/overpayment-guard";
import { isFutureDate } from "@/lib/payment-dates";
import { DEPOSIT_ADJUSTMENT_MODE, DEPOSIT_OVERRIDE_NOTE_MARKER, evaluateDepositGuard } from "@/lib/deposit-payment-guard";

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

  // Join settlement state for Razorpay payments, mirroring the inbox feed —
  // without it a settled payment reads as "not synced yet" wherever this
  // endpoint backs the shared payment panel.
  const rzpIds = (data || [])
    .map((p) => p.razorpay_payment_id as string | null)
    .filter(Boolean) as string[];

  if (rzpIds.length > 0) {
    const { data: sRows } = await supabase
      .from("razorpay_settlement_cache")
      .select("razorpay_payment_id, settled, settled_at, settlement_utr")
      .in("razorpay_payment_id", rzpIds);
    const byId = new Map((sRows || []).map((s) => [s.razorpay_payment_id as string, s]));
    for (const p of data || []) {
      const s = byId.get(p.razorpay_payment_id as string);
      Object.assign(p, {
        settled: (s?.settled as boolean | undefined) ?? null,
        settled_at: (s?.settled_at as string | null) ?? null,
        settlement_utr: (s?.settlement_utr as string | null) ?? null,
      });
    }
  }

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
  if (!dbUser || !canRecordPayments(dbUser.role)) {
    return NextResponse.json(
      { error: "Only admin or accounts can record payments. Use \"Report paid\" to tell accounts about one." },
      { status: 403 },
    );
  }

  const body = await request.json();
  const { amount, payment_date, payment_mode, payment_reference, proof_path, notes } = body;
  // TDS declared by the operator (never inferred). The cash received (amount) is
  // net; tds_amount is the customer's deduction. The statement settles on
  // (amount + tds_amount) so a TDS-short payment still closes the invoice.
  const tdsAmount  = Math.max(0, Number(body.tds_amount) || 0);
  const tdsSection = (typeof body.tds_section === "string" && body.tds_section.trim()) ? body.tds_section.trim() : null;

  if (!amount || amount <= 0) return NextResponse.json({ error: "Amount must be positive" }, { status: 400 });
  if (!payment_date) return NextResponse.json({ error: "Date received in bank is required" }, { status: 400 });
  if (isFutureDate(String(payment_date))) {
    return NextResponse.json({ error: "Date received in bank can't be in the future" }, { status: 400 });
  }
  if (!payment_mode) return NextResponse.json({ error: "Payment mode is required" }, { status: 400 });
  // Only approve_deposit_adjustment may create a deposit_adjustment payment —
  // posting one here would settle the invoice without the maker-checker step.
  if (payment_mode === DEPOSIT_ADJUSTMENT_MODE) {
    return NextResponse.json(
      { error: "Deposit adjustments go through \"Adjustment against deposit\", which needs admin or manager approval." },
      { status: 400 },
    );
  }

  // Fetch statement to validate
  const { data: statement } = await supabase
    .from("billing_statements")
    .select("id, total_amount, status, payment_status, contract_id")
    .eq("id", id)
    .single();

  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  if (statement.status === "draft") return NextResponse.json({ error: "Cannot record payment for a draft statement" }, { status: 400 });

  // Settling against a customer's deposit must use the deposit-adjustment flow.
  // Fails open (null) if the balance can't be read — a lookup outage must not
  // stop genuine receipts being recorded.
  let depositAvailable: number | null = null;
  if (statement.contract_id) {
    const { data: bal, error: balErr } = await createAdminClient()
      .rpc("get_deposit_available_balance", { p_contract_id: statement.contract_id });
    if (balErr) console.error("[payment] deposit balance lookup failed:", balErr.message);
    else depositAvailable = Number(bal?.[0]?.available ?? 0);
  }
  const overrideReason = typeof body.deposit_override_reason === "string" ? body.deposit_override_reason : null;
  const guard = evaluateDepositGuard({
    mode: payment_mode,
    reference: payment_reference,
    notes,
    depositAvailable,
    overrideReason,
  });
  if (!guard.ok) {
    return NextResponse.json(
      { error: guard.message, code: guard.code, deposit_available: depositAvailable },
      { status: 409 },
    );
  }

  // Insert payment — through the guarded RPC, which locks the statement, sums
  // what is already settled and refuses anything that would over-credit it.
  // A route-side check followed by an insert would still lose a race between
  // two submissions (and did let a receipt be recorded twice, days apart).
  const guarded = await createAdminClient().rpc("record_billing_payment_guarded", {
    p_statement_id: id,
    p_amount: Number(amount),
    p_payment_date: payment_date,
    p_payment_mode: payment_mode,
    p_payment_reference: payment_reference || null,
    p_proof_path: proof_path || null,
    p_notes: guard.overridden
      ? `${notes ? `${notes}\n` : ""}${DEPOSIT_OVERRIDE_NOTE_MARKER} — ${overrideReason!.trim()}]`
      : notes || null,
    p_tds_amount: tdsAmount,
    p_tds_section: tdsSection,
    p_recorded_by: dbUser.id,
  });
  if (guarded.error) return NextResponse.json({ error: guarded.error.message }, { status: 500 });

  const outcome = (guarded.data as Array<{
    success: boolean;
    error_code: string | null;
    outstanding: number | string | null;
    settled: number | string | null;
    payment: Record<string, unknown> | null;
  }> | null)?.[0];
  if (!outcome) return NextResponse.json({ error: "Could not record payment" }, { status: 500 });

  if (!outcome.success) {
    if (outcome.error_code === OVERPAYMENT_CODE) {
      const outstanding = Number(outcome.outstanding ?? 0);
      return NextResponse.json(
        {
          error: overpaymentMessage({
            outstanding,
            settled: Number(outcome.settled ?? 0),
            attempted: Number(amount) + tdsAmount,
          }),
          code: OVERPAYMENT_CODE,
          outstanding,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "Statement not found" }, { status: 404 });
  }
  const payment = outcome.payment as { id: string } & Record<string, unknown>;

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

  // Check if fully paid, persist payment_status, and fire the paid-transition
  // chain (GST auto-gen / v2 handoff). Shared with the deposit-adjustment
  // approval path so both payment sources settle identically.
  const settlement = await finalizeBillingPayment(supabase, {
    statementId: id,
    statementTotalAmount: statement.total_amount,
    previousPaymentStatus: statement.payment_status,
    reason: "manual_payment_entry",
    performedBy: dbUser.id,
  });
  const newPaymentStatus = settlement.paymentStatus;

  logAudit(supabase, {
    entityType: "billing_statement",
    entityId: id,
    action: "update",
    performedBy: dbUser.id,
    changes: {
      payment_recorded: { old: null, new: `${payment_mode} ₹${amount} ref:${payment_reference || "—"}` },
      payment_status: { old: statement.payment_status, new: newPaymentStatus },
      ...(guard.overridden
        ? { deposit_guard_override: { old: null, new: `₹${depositAvailable} deposit available: ${overrideReason!.trim()}` } }
        : {}),
    },
  });

  return NextResponse.json({
    data: payment,
    payment_status: newPaymentStatus,
    total_paid: settlement.totalPaid,
    balance_due: settlement.balanceDue,
  });
}
