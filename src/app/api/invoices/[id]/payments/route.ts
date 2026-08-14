import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { InboxPayment } from "@/lib/tally-handoff";

/**
 * GET /api/invoices/[id]/payments
 *
 * Returns the billing_payments collected against the ad-hoc invoice's
 * current (non-voided) linked billing_statements row, in the same
 * InboxPayment shape the Tally Inbox already renders — powers the "Paid"
 * badge popover on the lead page so it shows the same payment detail
 * (amount, mode, reference/txn id, recorded by, Razorpay settlement) that's
 * already visible in the accounting inbox for the same underlying rows.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: statement } = await supabase
    .from("billing_statements")
    .select("id, total_amount")
    .eq("invoice_id", id)
    .is("voided_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!statement) {
    return NextResponse.json({ error: "No billing statement found for this invoice" }, { status: 404 });
  }

  const { data: paymentRows, error } = await supabase
    .from("billing_payments")
    .select("id, amount, payment_date, payment_mode, payment_reference, notes, razorpay_payment_id, recorder:users!billing_payments_recorded_by_fkey(full_name)")
    .eq("billing_statement_id", statement.id)
    .order("payment_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rzpIds = (paymentRows || [])
    .map((p) => p.razorpay_payment_id as string | null)
    .filter(Boolean) as string[];

  const settlementMap = new Map<string, { settled: boolean; settled_at: string | null; settlement_utr: string | null }>();
  if (rzpIds.length > 0) {
    const { data: settlementRows } = await supabase
      .from("razorpay_settlement_cache")
      .select("razorpay_payment_id, settled, settled_at, settlement_utr")
      .in("razorpay_payment_id", rzpIds);
    for (const s of settlementRows || []) {
      settlementMap.set(s.razorpay_payment_id as string, {
        settled: s.settled as boolean,
        settled_at: (s.settled_at as string | null) ?? null,
        settlement_utr: (s.settlement_utr as string | null) ?? null,
      });
    }
  }

  const payments: InboxPayment[] = (paymentRows || []).map((p) => {
    const rzpId = (p.razorpay_payment_id as string | null) ?? null;
    const settlement = rzpId ? (settlementMap.get(rzpId) ?? null) : null;
    const recorderRaw = p.recorder as { full_name: string | null } | { full_name: string | null }[] | null;
    const recorder = Array.isArray(recorderRaw) ? recorderRaw[0] ?? null : recorderRaw;
    return {
      id: p.id as string,
      amount: Number(p.amount),
      payment_date: p.payment_date as string,
      payment_mode: p.payment_mode as string,
      payment_reference: (p.payment_reference as string | null) ?? null,
      notes: (p.notes as string | null) ?? null,
      razorpay_payment_id: rzpId,
      recorded_by_name: recorder?.full_name ?? null,
      settled: settlement?.settled ?? null,
      settled_at: settlement?.settled_at ?? null,
      settlement_utr: settlement?.settlement_utr ?? null,
    };
  });

  return NextResponse.json({ payments, total_amount: Number(statement.total_amount) });
}
