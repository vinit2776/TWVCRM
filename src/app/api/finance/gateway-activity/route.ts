import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/finance/gateway-activity
 *
 * Returns all Razorpay-captured transactions aggregated across:
 *   - booking_payments  (razorpay checkout / payment link → booking)
 *   - billing_payments  (razorpay payment link → billing statement)
 *
 * Settlement data is fetched separately from razorpay_settlement_cache
 * and merged in JS (no FK between the tables).
 *
 * Query params:
 *   from_date   YYYY-MM-DD  (default: 90 days ago)
 *   to_date     YYYY-MM-DD  (default: today)
 *   settled     "true" | "false" | ""  (filter by settlement status)
 *   entity_type "booking" | "billing_statement" | ""
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  const ALLOWED_ROLES = ["admin", "manager", "accounts"];
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const entityTypeFilter = searchParams.get("entity_type") || "";
  const settledFilter = searchParams.get("settled") || "";

  // Default: last 90 days
  const toDate = searchParams.get("to_date") || new Date().toISOString().slice(0, 10);
  const fromDateDefault = new Date();
  fromDateDefault.setDate(fromDateDefault.getDate() - 90);
  const fromDate = searchParams.get("from_date") || fromDateDefault.toISOString().slice(0, 10);

  const adminSupabase = createAdminClient();

  // ── 1. Booking payments via Razorpay ─────────────────────────────────────
  const bookingQuery = adminSupabase
    .from("booking_payments")
    .select(`
      id,
      amount,
      razorpay_payment_id,
      payment_reference,
      status,
      created_at,
      bookings!inner(
        id,
        booking_number,
        leads(first_name, last_name, company)
      )
    `)
    .eq("payment_mode", "razorpay")
    .eq("status", "verified")
    .gte("created_at", fromDate + "T00:00:00Z")
    .lte("created_at", toDate + "T23:59:59Z")
    .order("created_at", { ascending: false });

  // ── 2. Billing payments via Razorpay ─────────────────────────────────────
  const billingQuery = adminSupabase
    .from("billing_payments")
    .select(`
      id,
      amount,
      razorpay_payment_id,
      payment_reference,
      payment_date,
      created_at,
      billing_statements!inner(
        id,
        statement_number,
        contracts(
          id,
          contract_number,
          leads(first_name, last_name, company)
        )
      )
    `)
    .eq("payment_mode", "razorpay")
    .gte("created_at", fromDate + "T00:00:00Z")
    .lte("created_at", toDate + "T23:59:59Z")
    .order("created_at", { ascending: false });

  // ── 3. Last sync log ──────────────────────────────────────────────────────
  const syncLogQuery = adminSupabase
    .from("razorpay_sync_log")
    .select("synced_at, records_updated, error_message")
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const [bookingRes, billingRes, syncLogRes] = await Promise.all([
    bookingQuery,
    billingQuery,
    syncLogQuery,
  ]);

  // ── 4. Collect all razorpay_payment_ids and fetch settlement cache ───────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allPaymentIds: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (bookingRes.data || []) as any[]) {
    if (row.razorpay_payment_id) allPaymentIds.push(row.razorpay_payment_id);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (billingRes.data || []) as any[]) {
    if (row.razorpay_payment_id) allPaymentIds.push(row.razorpay_payment_id);
  }

  type SettlementCache = {
    razorpay_payment_id: string;
    settled: boolean;
    settlement_id: string | null;
    settlement_utr: string | null;
    settled_at: string | null;
    fee: number | null;
    tax: number | null;
    payment_method: string | null;
  };

  const cacheMap = new Map<string, SettlementCache>();

  if (allPaymentIds.length > 0) {
    const { data: cacheRows } = await adminSupabase
      .from("razorpay_settlement_cache")
      .select("razorpay_payment_id, settled, settlement_id, settlement_utr, settled_at, fee, tax, payment_method")
      .in("razorpay_payment_id", allPaymentIds);

    for (const c of (cacheRows || []) as SettlementCache[]) {
      cacheMap.set(c.razorpay_payment_id, c);
    }
  }

  // ── Normalise booking rows ────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bookingRows = (bookingRes.data || []).map((row: any) => {
    const booking = Array.isArray(row.bookings) ? row.bookings[0] : row.bookings;
    const lead    = booking?.leads
      ? (Array.isArray(booking.leads) ? booking.leads[0] : booking.leads)
      : null;
    const cache = row.razorpay_payment_id ? cacheMap.get(row.razorpay_payment_id) ?? null : null;

    return {
      id:                   row.id,
      entity_type:          "booking" as const,
      entity_id:            booking?.id ?? null,
      entity_ref:           booking?.booking_number ?? null,
      entity_label:         booking?.booking_number ? `Booking ${booking.booking_number}` : "Booking",
      entity_href:          booking?.id ? `/bookings/${booking.id}` : null,
      customer_name:        lead
        ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company || "—"
        : "—",
      amount:               Number(row.amount),
      razorpay_payment_id:  row.razorpay_payment_id ?? null,
      payment_reference:    row.payment_reference ?? null,
      captured:             true,
      created_at:           row.created_at,
      settled:              cache?.settled ?? false,
      settlement_id:        cache?.settlement_id ?? null,
      settlement_utr:       cache?.settlement_utr ?? null,
      settled_at:           cache?.settled_at ?? null,
      fee:                  cache?.fee != null ? Number(cache.fee) : null,
      tax:                  cache?.tax != null ? Number(cache.tax) : null,
      payment_method:       cache?.payment_method ?? null,
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const billingRows = (billingRes.data || []).map((row: any) => {
    const statement = Array.isArray(row.billing_statements)
      ? row.billing_statements[0]
      : row.billing_statements;
    const contract = statement?.contracts
      ? (Array.isArray(statement.contracts) ? statement.contracts[0] : statement.contracts)
      : null;
    const lead = contract?.leads
      ? (Array.isArray(contract.leads) ? contract.leads[0] : contract.leads)
      : null;
    const cache = row.razorpay_payment_id ? cacheMap.get(row.razorpay_payment_id) ?? null : null;

    return {
      id:                   row.id,
      entity_type:          "billing_statement" as const,
      entity_id:            statement?.id ?? null,
      entity_ref:           statement?.statement_number ?? null,
      entity_label:         statement?.statement_number ? `Invoice ${statement.statement_number}` : "Invoice",
      entity_href:          contract?.id ? `/billing?contract=${contract.id}` : null,
      customer_name:        lead
        ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company || "—"
        : "—",
      amount:               Number(row.amount),
      razorpay_payment_id:  row.razorpay_payment_id ?? null,
      payment_reference:    row.payment_reference ?? null,
      captured:             true,
      created_at:           row.created_at ?? (row.payment_date + "T00:00:00Z"),
      settled:              cache?.settled ?? false,
      settlement_id:        cache?.settlement_id ?? null,
      settlement_utr:       cache?.settlement_utr ?? null,
      settled_at:           cache?.settled_at ?? null,
      fee:                  cache?.fee != null ? Number(cache.fee) : null,
      tax:                  cache?.tax != null ? Number(cache.tax) : null,
      payment_method:       cache?.payment_method ?? null,
    };
  });

  // ── Merge, filter, sort ───────────────────────────────────────────────────
  let allRows = [...bookingRows, ...billingRows];

  if (entityTypeFilter) {
    allRows = allRows.filter((r) => r.entity_type === entityTypeFilter);
  }
  if (settledFilter === "true") {
    allRows = allRows.filter((r) => r.settled === true);
  } else if (settledFilter === "false") {
    allRows = allRows.filter((r) => r.settled === false);
  }

  allRows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  // ── Summary totals ────────────────────────────────────────────────────────
  const totalCaptured  = allRows.reduce((s, r) => s + r.amount, 0);
  const totalSettled   = allRows.filter((r) => r.settled).reduce((s, r) => s + r.amount, 0);
  const totalPending   = totalCaptured - totalSettled;
  const totalFees      = allRows.reduce((s, r) => s + (r.fee ?? 0), 0);

  return NextResponse.json({
    data: allRows,
    summary: {
      total_captured:  totalCaptured,
      total_settled:   totalSettled,
      total_pending:   totalPending,
      total_fees:      totalFees,
      count:           allRows.length,
    },
    last_sync: syncLogRes.data ?? null,
  });
}
