/**
 * GET /api/leads/[id]/billing-summary?period=lifetime|fy_current
 *
 * Aggregates everything finance considers "money received from this
 * lead" for the lead profile snippet:
 *   - verified booking_payments on bookings owned by this lead
 *   - verified contract_payments on contracts owned by this lead
 *
 * Returns flat KPIs + a monthly time series the LineGraph component
 * renders. The whole thing is one round-trip; the snippet doesn't
 * need to compute anything client-side.
 *
 * `period` defaults to lifetime. `fy_current` = Indian financial
 * year (April 1 → March 31), computed against today.
 *
 * Auth: any authenticated user (mirrors the lead detail page).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

interface MonthlyPoint {
  month: string;        // YYYY-MM, IST
  amount: number;       // ₹
}

function currentFinancialYearStart(): Date {
  // Indian FY: starts April 1. If we're before April, FY started last year.
  const now = new Date();
  const istNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const month = istNow.getMonth(); // 0 = Jan, 3 = Apr
  const year = month >= 3 ? istNow.getFullYear() : istNow.getFullYear() - 1;
  return new Date(`${year}-04-01T00:00:00+05:30`);
}

function istMonthKey(iso: string): string {
  // YYYY-MM in IST regardless of server timezone
  const d = new Date(iso);
  const year = d.toLocaleString("en-CA", { timeZone: "Asia/Kolkata", year: "numeric" });
  const month = d.toLocaleString("en-CA", { timeZone: "Asia/Kolkata", month: "2-digit" });
  return `${year}-${month}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: leadId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const period = searchParams.get("period") || "lifetime";

  const fromDate = period === "fy_current" ? currentFinancialYearStart() : null;
  const fromIso = fromDate?.toISOString();

  // ── 1. Booking payments ──────────────────────────────────────────
  // Only bookings whose lead_id matches; only verified payments.
  const { data: bookings } = await supabase
    .from("bookings")
    .select("id")
    .eq("lead_id", leadId);
  const bookingIds = (bookings || []).map((b) => b.id);

  const bookingPayments: { amount: number; created_at: string }[] = [];
  if (bookingIds.length > 0) {
    let query = supabase
      .from("booking_payments")
      .select("amount, created_at")
      .in("booking_id", bookingIds)
      .eq("status", "verified");
    if (fromIso) query = query.gte("created_at", fromIso);
    const { data } = await query;
    if (data) bookingPayments.push(...data);
  }

  // ── 2. Contract payments ─────────────────────────────────────────
  // Lead → contracts → contract_payments.
  const { data: contracts } = await supabase
    .from("contracts")
    .select("id")
    .eq("lead_id", leadId);
  const contractIds = (contracts || []).map((c) => c.id);

  const contractPayments: { amount: number; payment_date: string }[] = [];
  if (contractIds.length > 0) {
    // status='verified' mirrors the booking_payments filter — only
    // successfully completed transactions count toward the snapshot.
    // Pending and rejected rows would otherwise inflate "money this
    // customer has paid us" with money we don't actually have.
    let query = supabase
      .from("contract_payments")
      .select("amount, payment_date")
      .in("contract_id", contractIds)
      .eq("status", "verified");
    if (fromIso) query = query.gte("payment_date", fromIso.slice(0, 10));
    const { data } = await query;
    if (data) contractPayments.push(...data);
  }

  // ── 3. Aggregate ─────────────────────────────────────────────────
  const allTransactions = [
    ...bookingPayments.map((p) => ({ amount: Number(p.amount), at: p.created_at })),
    ...contractPayments.map((p) => ({ amount: Number(p.amount), at: p.payment_date })),
  ];

  const totalRevenue = allTransactions.reduce((s, t) => s + t.amount, 0);
  const transactionCount = allTransactions.length;
  const avgTransaction = transactionCount > 0 ? totalRevenue / transactionCount : 0;

  const dates = allTransactions.map((t) => new Date(t.at).getTime()).sort((a, b) => a - b);
  const firstAt = dates.length > 0 ? new Date(dates[0]).toISOString() : null;
  const lastAt  = dates.length > 0 ? new Date(dates[dates.length - 1]).toISOString() : null;

  // Monthly bucketing (IST). For lifetime, walk from firstAt to now;
  // for fy_current, walk from FY start to now. Empty months get 0
  // so the line graph doesn't have visual gaps.
  const startBucket = fromDate ?? (firstAt ? new Date(firstAt) : null);
  const monthly: MonthlyPoint[] = [];
  if (startBucket) {
    const byMonth = new Map<string, number>();
    for (const t of allTransactions) {
      const key = istMonthKey(t.at);
      byMonth.set(key, (byMonth.get(key) || 0) + t.amount);
    }
    // Walk month by month from startBucket to today
    const cursor = new Date(startBucket);
    cursor.setUTCDate(1);
    const today = new Date();
    while (cursor <= today) {
      const key = istMonthKey(cursor.toISOString());
      monthly.push({ month: key, amount: parseFloat((byMonth.get(key) || 0).toFixed(2)) });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  return NextResponse.json({
    data: {
      period,
      total_revenue: parseFloat(totalRevenue.toFixed(2)),
      transaction_count: transactionCount,
      avg_transaction: parseFloat(avgTransaction.toFixed(2)),
      first_paid_at: firstAt,
      last_paid_at: lastAt,
      by_source: {
        bookings: bookingPayments.reduce((s, p) => s + Number(p.amount), 0),
        contracts: contractPayments.reduce((s, p) => s + Number(p.amount), 0),
      },
      monthly,
    },
  });
}
