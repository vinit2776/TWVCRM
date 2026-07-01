import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/finance/gateway-activity
 *
 * PRIMARY SOURCE: razorpay_settlement_cache (all synced Razorpay payments).
 * ENRICHMENT: booking_payments + billing_payments (CRM records) matched by
 *   razorpay_payment_id or order_id → adds customer name + entity link.
 *
 * This ensures every synced payment shows in the list even if the CRM webhook
 * missed recording it.
 *
 * Query params:
 *   from_date   YYYY-MM-DD  (default: 90 days ago)
 *   to_date     YYYY-MM-DD  (default: today)
 *   settled     "true" | "false" | ""
 *   entity_type "booking" | "billing_statement" | "unmatched" | ""
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
  const settledFilter    = searchParams.get("settled") || "";

  const toDate = searchParams.get("to_date") || new Date().toISOString().slice(0, 10);
  const fromDateDefault = new Date();
  fromDateDefault.setDate(fromDateDefault.getDate() - 90);
  const fromDate = searchParams.get("from_date") || fromDateDefault.toISOString().slice(0, 10);

  const adminSupabase = createAdminClient();

  // ── 1. Primary: fetch all settlement cache rows ───────────────────────────
  // Fetch all rows (no server-side date filter) — the cache is small and we
  // apply date filtering in JS below so we can handle NULL payment_created_at
  // gracefully (rows not yet backfilled by a re-sync are always included).
  const { data: cacheRows, error: cacheError } = await adminSupabase
    .from("razorpay_settlement_cache")
    .select("razorpay_payment_id, settled, settlement_id, settlement_utr, settled_at, fee, tax, payment_method, amount, order_id, payment_created_at")
    .order("payment_created_at", { ascending: false, nullsFirst: false });

  if (cacheError) {
    console.error("[gateway-activity] settlement_cache query error:", cacheError);
    return NextResponse.json({ error: cacheError.message }, { status: 500 });
  }

  const cache = cacheRows ?? [];
  if (cache.length === 0) {
    return NextResponse.json({
      data: [],
      summary: { total_captured: 0, total_settled: 0, total_pending: 0, total_fees: 0, count: 0 },
      last_sync: null,
    });
  }

  // ── 2. Collect IDs for CRM lookup ─────────────────────────────────────────
  const paymentIds = cache.map((r) => r.razorpay_payment_id).filter(Boolean);
  const orderIds   = cache.map((r) => r.order_id).filter(Boolean) as string[];

  // ── 2b. Manual links enrichment ───────────────────────────────────────────
  const { data: manualLinks } = await adminSupabase
    .from("razorpay_manual_links")
    .select("razorpay_payment_id, entity_type, entity_id, notes, linked_at, users:linked_by(full_name)")
    .in("razorpay_payment_id", paymentIds.length ? paymentIds : ["__none__"]);

  const manualLinkMap = new Map<string, {
    entity_type: string; entity_id: string; notes: string | null;
    linked_at: string; linked_by_name: string | null;
  }>();
  for (const ml of manualLinks ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const u = (ml as any).users;
    manualLinkMap.set(ml.razorpay_payment_id, {
      entity_type:    ml.entity_type,
      entity_id:      ml.entity_id,
      notes:          ml.notes ?? null,
      linked_at:      ml.linked_at,
      linked_by_name: u ? (Array.isArray(u) ? u[0]?.full_name : u.full_name) : null,
    });
  }

  // Resolve entity labels for manual links (contracts / booking / billing_statement)
  const manualContractIds  = [...manualLinkMap.values()].filter(m => m.entity_type === "contract").map(m => m.entity_id);
  const manualBookingIds   = [...manualLinkMap.values()].filter(m => m.entity_type === "booking").map(m => m.entity_id);
  const manualStatementIds = [...manualLinkMap.values()].filter(m => m.entity_type === "billing_statement").map(m => m.entity_id);

  const [{ data: mlContracts }, { data: mlBookings }, { data: mlStatements }] = await Promise.all([
    manualContractIds.length
      ? adminSupabase.from("contracts").select("id, contract_number, leads(first_name, last_name, company)").in("id", manualContractIds)
      : Promise.resolve({ data: [] }),
    manualBookingIds.length
      ? adminSupabase.from("bookings").select("id, booking_number, leads(first_name, last_name, company)").in("id", manualBookingIds)
      : Promise.resolve({ data: [] }),
    manualStatementIds.length
      ? adminSupabase.from("billing_statements").select("id, statement_number, contracts(contract_number, leads(first_name, last_name, company))").in("id", manualStatementIds)
      : Promise.resolve({ data: [] }),
  ]);

  type ManualEnriched = {
    entity_type: "contract" | "booking" | "billing_statement";
    entity_id: string; entity_ref: string | null; entity_label: string;
    entity_href: string | null; customer_name: string;
    notes: string | null; linked_at: string; linked_by_name: string | null;
  };
  const manualEnrichedMap = new Map<string, ManualEnriched>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getLead = (obj: any) => {
    const l = obj?.leads;
    return l ? (Array.isArray(l) ? l[0] : l) : null;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leadName = (lead: any) =>
    lead ? ([lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company || "—") : "—";

  for (const [pid, ml] of manualLinkMap.entries()) {
    if (ml.entity_type === "contract") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (mlContracts ?? []).find((x: any) => x.id === ml.entity_id) as any;
      manualEnrichedMap.set(pid, {
        entity_type: "contract", entity_id: ml.entity_id,
        entity_ref: c?.contract_number ?? null,
        entity_label: c?.contract_number ? `Contract ${c.contract_number}` : "Contract",
        entity_href: c ? `/contracts/${c.id}` : null,
        customer_name: leadName(getLead(c)),
        notes: ml.notes, linked_at: ml.linked_at, linked_by_name: ml.linked_by_name,
      });
    } else if (ml.entity_type === "booking") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = (mlBookings ?? []).find((x: any) => x.id === ml.entity_id) as any;
      manualEnrichedMap.set(pid, {
        entity_type: "booking", entity_id: ml.entity_id,
        entity_ref: b?.booking_number ?? null,
        entity_label: b?.booking_number ? `Booking ${b.booking_number}` : "Booking",
        entity_href: b ? `/bookings/${b.id}` : null,
        customer_name: leadName(getLead(b)),
        notes: ml.notes, linked_at: ml.linked_at, linked_by_name: ml.linked_by_name,
      });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = (mlStatements ?? []).find((x: any) => x.id === ml.entity_id) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contract = s?.contracts ? (Array.isArray(s.contracts) ? s.contracts[0] : s.contracts) as any : null;
      manualEnrichedMap.set(pid, {
        entity_type: "billing_statement", entity_id: ml.entity_id,
        entity_ref: s?.statement_number ?? null,
        entity_label: s?.statement_number ? `Invoice ${s.statement_number}` : "Invoice",
        entity_href: contract ? `/billing?contract=${contract.id}` : null,
        customer_name: leadName(getLead(contract)),
        notes: ml.notes, linked_at: ml.linked_at, linked_by_name: ml.linked_by_name,
      });
    }
  }

  // ── 3. CRM enrichment: booking_payments ───────────────────────────────────
  const bookingPaymentsRes = await adminSupabase
    .from("booking_payments")
    .select(`
      id, amount, razorpay_payment_id, razorpay_order_id, payment_reference, status, created_at,
      bookings!inner(
        id,
        booking_number,
        leads(first_name, last_name, company)
      )
    `)
    .eq("payment_mode", "razorpay")
    .or(
      [
        paymentIds.length ? `razorpay_payment_id.in.(${paymentIds.join(",")})` : null,
        orderIds.length   ? `razorpay_order_id.in.(${orderIds.join(",")})` : null,
      ].filter(Boolean).join(",") || "id.is.null"
    );

  if (bookingPaymentsRes.error) {
    console.error("[gateway-activity] booking_payments enrichment error:", bookingPaymentsRes.error);
  }

  // ── 4. CRM enrichment: billing_payments ───────────────────────────────────
  const billingPaymentsRes = await adminSupabase
    .from("billing_payments")
    .select(`
      id, amount, razorpay_payment_id, payment_reference, payment_date, created_at,
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
    .in("razorpay_payment_id", paymentIds.length ? paymentIds : ["__none__"]);

  if (billingPaymentsRes.error) {
    console.error("[gateway-activity] billing_payments enrichment error:", billingPaymentsRes.error);
  }

  // ── 5. Build enrichment lookup maps ──────────────────────────────────────
  type EnrichedCRM = {
    entity_type: "booking" | "billing_statement";
    entity_id: string | null;
    entity_ref: string | null;
    entity_label: string;
    entity_href: string | null;
    customer_name: string;
    crm_amount: number;
  };

  const crmByPaymentId = new Map<string, EnrichedCRM>();
  const crmByOrderId   = new Map<string, EnrichedCRM>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (bookingPaymentsRes.data ?? []) as any[]) {
    const booking = Array.isArray(row.bookings) ? row.bookings[0] : row.bookings;
    const lead    = booking?.leads
      ? (Array.isArray(booking.leads) ? booking.leads[0] : booking.leads)
      : null;
    const enriched: EnrichedCRM = {
      entity_type:   "booking",
      entity_id:     booking?.id ?? null,
      entity_ref:    booking?.booking_number ?? null,
      entity_label:  booking?.booking_number ? `Booking ${booking.booking_number}` : "Booking",
      entity_href:   booking?.id ? `/bookings/${booking.id}` : null,
      customer_name: lead
        ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company || "—"
        : "—",
      crm_amount: Number(row.amount),
    };
    if (row.razorpay_payment_id) crmByPaymentId.set(row.razorpay_payment_id, enriched);
    if (row.razorpay_order_id)   crmByOrderId.set(row.razorpay_order_id, enriched);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (billingPaymentsRes.data ?? []) as any[]) {
    const statement = Array.isArray(row.billing_statements)
      ? row.billing_statements[0]
      : row.billing_statements;
    const contract = statement?.contracts
      ? (Array.isArray(statement.contracts) ? statement.contracts[0] : statement.contracts)
      : null;
    const lead = contract?.leads
      ? (Array.isArray(contract.leads) ? contract.leads[0] : contract.leads)
      : null;
    const enriched: EnrichedCRM = {
      entity_type:   "billing_statement",
      entity_id:     statement?.id ?? null,
      entity_ref:    statement?.statement_number ?? null,
      entity_label:  statement?.statement_number ? `Invoice ${statement.statement_number}` : "Invoice",
      entity_href:   contract?.id ? `/billing?contract=${contract.id}` : null,
      customer_name: lead
        ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company || "—"
        : "—",
      crm_amount: Number(row.amount),
    };
    if (row.razorpay_payment_id) crmByPaymentId.set(row.razorpay_payment_id, enriched);
  }

  // ── 6. Last sync log ──────────────────────────────────────────────────────
  const { data: lastSyncRow } = await adminSupabase
    .from("razorpay_sync_log")
    .select("synced_at, records_updated, error_message")
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // ── 7. Merge cache rows with CRM enrichment ───────────────────────────────
  let allRows = cache.map((c) => {
    const crm = crmByPaymentId.get(c.razorpay_payment_id)
              ?? (c.order_id ? crmByOrderId.get(c.order_id) : null)
              ?? null;
    const manual = crm ? null : (manualEnrichedMap.get(c.razorpay_payment_id) ?? null);

    return {
      id:                   c.razorpay_payment_id,
      entity_type:          crm?.entity_type ?? manual?.entity_type ?? ("unmatched" as const),
      entity_id:            crm?.entity_id   ?? manual?.entity_id   ?? null,
      entity_ref:           crm?.entity_ref  ?? manual?.entity_ref  ?? null,
      entity_label:         crm?.entity_label ?? manual?.entity_label ?? "Razorpay (not in CRM)",
      entity_href:          crm?.entity_href  ?? manual?.entity_href  ?? null,
      customer_name:        crm?.customer_name ?? manual?.customer_name ?? "—",
      amount:               crm?.crm_amount ?? (c.amount != null ? Number(c.amount) : 0),
      razorpay_payment_id:  c.razorpay_payment_id,
      payment_reference:    c.order_id ?? null,
      captured:             true,
      created_at:           c.payment_created_at ?? new Date().toISOString(),
      settled:              c.settled ?? false,
      settlement_id:        c.settlement_id ?? null,
      settlement_utr:       c.settlement_utr ?? null,
      settled_at:           c.settled_at ?? null,
      fee:                  c.fee != null ? Number(c.fee) : null,
      tax:                  c.tax != null ? Number(c.tax) : null,
      payment_method:       c.payment_method ?? null,
      in_crm:               crm !== null,
      manually_linked:      manual !== null,
      link_notes:           manual?.notes ?? null,
      link_linked_at:       manual?.linked_at ?? null,
      link_linked_by:       manual?.linked_by_name ?? null,
    };
  });

  // Apply date filter in JS — rows with NULL payment_created_at always pass through
  const fromMs = new Date(fromDate + "T00:00:00Z").getTime();
  const toMs   = new Date(toDate   + "T23:59:59Z").getTime();
  allRows = allRows.filter((r) => {
    if (!r.created_at) return true;
    const t = new Date(r.created_at).getTime();
    return t >= fromMs && t <= toMs;
  });

  // Filter by entity type
  if (entityTypeFilter && entityTypeFilter !== "unmatched") {
    allRows = allRows.filter((r) => r.entity_type === entityTypeFilter);
  } else if (entityTypeFilter === "unmatched") {
    allRows = allRows.filter((r) => !r.in_crm);
  }

  if (settledFilter === "true") {
    allRows = allRows.filter((r) => r.settled === true);
  } else if (settledFilter === "false") {
    allRows = allRows.filter((r) => r.settled === false);
  }

  allRows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const totalCaptured = allRows.reduce((s, r) => s + r.amount, 0);
  const totalSettled  = allRows.filter((r) => r.settled).reduce((s, r) => s + r.amount, 0);
  const totalPending  = totalCaptured - totalSettled;
  const totalFees     = allRows.reduce((s, r) => s + (r.fee ?? 0), 0);

  return NextResponse.json({
    data: allRows,
    summary: {
      total_captured:  totalCaptured,
      total_settled:   totalSettled,
      total_pending:   totalPending,
      total_fees:      totalFees,
      count:           allRows.length,
    },
    last_sync: lastSyncRow ?? null,
  });
}
