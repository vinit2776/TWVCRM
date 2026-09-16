import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createUsageChargeSchema } from "@/lib/validations";
import { logAudit } from "@/lib/audit";
import { isContractOperational, CHARGE_ALLOWED_ROLES, USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS } from "@/lib/constants";
import { nextUsageRun, type NextRun, type MonthCoverage, type NextRunContract } from "@/lib/usage-next-run";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";

// A charge/usage row normalized to one shared shape regardless of which
// table it came from, so the existing usage_charges-shaped table UI (Qty,
// Unit Price, Total, GST, Charge Date, Billing Period, Status) renders any
// of the three sources without special-casing per column.
interface NormalizedRow {
  id: string;
  source: "manual" | "print" | "facility";
  description: string;
  contract_id: string | null;
  contract: { id: string; contract_number: string; billing_cycle?: string | null } | null;
  booking_id?: string | null;
  booking?: { id: string; booking_number: string; booking_date: string } | null;
  lead: { first_name?: string | null; last_name?: string | null; company?: string | null } | null;
  quantity: number;
  unit_price: number;
  total: number;
  gst_rate: number | null;
  gst_amount: number | null;
  total_with_gst: number | null;
  charge_date: string;
  status: "pending" | "billed" | "waived";
  // null = not a meaningful distinction for this source (every manual
  // charge is billable unless waived, which the status already shows).
  billable: boolean | null;
  notes: string | null;
  created_at: string;
  /** Which billing cycle this row's charge_date falls into, and whether that
   *  cycle has already been picked up by a usage run. See billingCycleOf(). */
  billing_cycle_status: "cycle_open" | "ready" | "overdue" | "billed" | "waived" | "supplemental_needed";
  /** "August 2026" — the month this charge belongs to, for the "Bills in: …" tag. */
  billing_cycle_label: string;
  /** Manual/ad-hoc rows only — non-null excludes this charge from the next
   *  Generate Drafts sweep without changing its status. See held_at's own
   *  doc comment (00558_usage_charge_hold.sql). */
  held_at: string | null;
  hold_reason: string | null;
  waive_reason: string | null;
  waived_at: string | null;
  waived_by_name: string | null;
  /** Set by the "Bill anyway" action on a stale (see
   *  USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS) charge — lets the frontend
   *  suppress its own "needs review" flag once someone has acknowledged it. */
  reviewed_at: string | null;
  /** Pending, billable rows only: which Generate & Send run this charge
   *  lands in, for the "Bills in" line under Logged. See usage-next-run.ts. */
  next_run?: NextRun | null;
}

function lastDayOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/**
 * Usage bills in arrears for the last FULLY-CLOSED month (see
 * generateUsageStatements in src/lib/billing.ts) — a charge dated in the
 * still-open current month can't be billed yet, one dated in the closed
 * month is what the next "Generate Drafts" run will pick up, and one dated
 * before that is stranded: no future run's single-month window will ever
 * reach it again unless someone notices it here.
 */
function billingCycleOf(
  chargeDate: string,
  status: "pending" | "billed" | "waived",
  /** True when a covering (sent/paid) usage/combined statement already
   *  exists for this exact contract+month — see the post-merge pass in GET
   *  below, which is the only caller that ever passes true. A pending charge
   *  in that state needs a SUPPLEMENTAL statement (generateUsageStatements
   *  in billing.ts), not the ordinary next "Generate Drafts" run. */
  hasCoveringStatement = false,
): { status: NormalizedRow["billing_cycle_status"]; label: string } {
  const [y, m] = chargeDate.slice(0, 7).split("-").map(Number);
  const label = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });
  if (status === "billed") return { status: "billed", label };
  if (status === "waived") return { status: "waived", label };
  if (hasCoveringStatement) return { status: "supplemental_needed", label };

  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const currentMonth = nowIst.getUTCMonth() + 1;
  const currentYear = nowIst.getUTCFullYear();
  const closed = currentMonth === 1 ? { month: 12, year: currentYear - 1 } : { month: currentMonth - 1, year: currentYear };

  if (y === currentYear && m === currentMonth) return { status: "cycle_open", label };
  if (y === closed.year && m === closed.month) return { status: "ready", label };
  return { status: "overdue", label };
}

/**
 * Contract+month pairs (as "contractId:YYYY-MM") that already have a
 * covering usage/combined statement sent to the client, paid, or GST-issued
 * — same "wasSentOrPaid" test generateUsageStatements uses to decide
 * alreadySent vs supersedable. A pending charge landing in one of these
 * needs a supplemental statement, not the ordinary next-run pickup.
 */
async function fetchCoveringPeriods(
  supabase: Awaited<ReturnType<typeof createClient>>,
  contractIds: string[],
): Promise<Set<string>> {
  const covering = new Set<string>();
  if (contractIds.length === 0) return covering;

  const { data } = await supabase
    .from("billing_statements")
    .select("contract_id, period_start, proforma_sent_at, gst_invoice_number, billing_payments:billing_payments(id)")
    .in("contract_id", contractIds)
    .in("statement_type", ["usage", "combined"])
    .is("voided_at", null);

  for (const s of (data ?? []) as Array<{
    contract_id: string; period_start: string;
    proforma_sent_at: string | null; gst_invoice_number: string | null;
    billing_payments: { id: string }[];
  }>) {
    const wasSentOrPaid = !!s.proforma_sent_at || !!s.gst_invoice_number || (s.billing_payments?.length ?? 0) > 0;
    if (wasSentOrPaid) covering.add(`${s.contract_id}:${s.period_start.slice(0, 7)}`);
  }
  return covering;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeManual(r: any): NormalizedRow {
  const cycle = billingCycleOf(r.charge_date, r.status);
  return {
    id: r.id, source: "manual", description: r.description,
    contract_id: r.contract_id, contract: r.contract ?? null,
    booking_id: r.booking_id, booking: r.booking ?? null,
    lead: r.lead ?? r.booking?.lead ?? null,
    quantity: Number(r.quantity), unit_price: Number(r.unit_price), total: Number(r.total),
    gst_rate: r.gst_rate, gst_amount: r.gst_amount, total_with_gst: r.total_with_gst,
    charge_date: r.charge_date, status: r.status, billable: null,
    notes: r.notes, created_at: r.created_at,
    billing_cycle_status: cycle.status, billing_cycle_label: cycle.label,
    held_at: r.held_at ?? null, hold_reason: r.hold_reason ?? null,
    waive_reason: r.waive_reason ?? null, waived_at: r.waived_at ?? null,
    waived_by_name: r.waived_by_user?.full_name ?? null,
    reviewed_at: r.reviewed_at ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizePrint(r: any): NormalizedRow {
  const overage = Number(r.overage_quantity);
  const serviceName = r.service?.name ?? "Print usage";
  const chargeDate = lastDayOfMonth(r.period_year, r.period_month);
  const status: "pending" | "billed" | "waived" = r.waived_at ? "waived" : (r.is_billed ? "billed" : "pending");
  const cycle = billingCycleOf(chargeDate, status);
  return {
    id: r.id, source: "print",
    description: overage > 0
      ? `${serviceName} — ${r.quantity_used} used, ${overage} over quota`
      : `${serviceName} — ${r.quantity_used} used (within quota)`,
    contract_id: r.contract_id, contract: r.contract ? { id: r.contract.id, contract_number: r.contract.contract_number, billing_cycle: r.contract.billing_cycle } : null,
    lead: r.contract?.lead ?? null,
    quantity: overage, unit_price: Number(r.overage_rate_snapshot), total: Number(r.amount),
    gst_rate: r.gst_rate, gst_amount: r.gst_amount, total_with_gst: r.total_with_gst,
    charge_date: chargeDate,
    status,
    billable: Number(r.amount) > 0,
    notes: r.notes, created_at: r.created_at,
    billing_cycle_status: cycle.status, billing_cycle_label: cycle.label,
    held_at: r.held_at ?? null, hold_reason: r.hold_reason ?? null,
    waive_reason: r.waive_reason ?? null, waived_at: r.waived_at ?? null, waived_by_name: r.waived_by_user?.full_name ?? null,
    reviewed_at: r.reviewed_at ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeFacility(r: any): NormalizedRow {
  const facilityName = r.contract_facility?.name ?? "Facility usage";
  const unit = r.contract_facility?.unit ? ` ${r.contract_facility.unit}` : "";
  const billable = Number(r.billable_quantity);
  const chargeDate = r.accounting_period ? lastDayOfMonth(r.accounting_period.year, r.accounting_period.month) : (r.created_at ?? "").slice(0, 10);
  // billing_statement_id (00563_usage_billing_engine.sql) is now the
  // authoritative "already on an invoice" signal, same as usage_charges —
  // the accounting-period-locked check stays as a fallback for rows from
  // before that column existed.
  const status: "pending" | "billed" | "waived" = r.waived_at
    ? "waived"
    : (r.billing_statement_id || r.accounting_period?.status === "locked") ? "billed" : "pending";
  const cycle = billingCycleOf(chargeDate, status);
  return {
    id: r.id, source: "facility",
    description: billable > 0
      ? `${facilityName} — ${r.quantity_used}${unit} used, ${billable}${unit} billable`
      : `${facilityName} — ${r.quantity_used}${unit} used (within quota)`,
    contract_id: r.contract_id, contract: r.contract ? { id: r.contract.id, contract_number: r.contract.contract_number, billing_cycle: r.contract.billing_cycle } : null,
    lead: r.contract?.lead ?? null,
    quantity: billable, unit_price: Number(r.unit_price), total: Number(r.total_charge),
    gst_rate: null, gst_amount: null, total_with_gst: null,
    charge_date: chargeDate,
    status,
    billable: billable > 0,
    notes: r.notes, created_at: r.created_at,
    billing_cycle_status: cycle.status, billing_cycle_label: cycle.label,
    held_at: r.held_at ?? null, hold_reason: r.hold_reason ?? null,
    waive_reason: r.waive_reason ?? null, waived_at: r.waived_at ?? null, waived_by_name: r.waived_by_user?.full_name ?? null,
    reviewed_at: r.reviewed_at ?? null,
  };
}

/** Fills row.next_run for this page's pending, billable contract rows —
 *  two batched queries (contracts, usage/combined statements), never per row. */
async function attachNextRun(
  supabase: Awaited<ReturnType<typeof createClient>>,
  rows: NormalizedRow[],
): Promise<void> {
  const targets = rows.filter((r) => r.status === "pending" && r.billable !== false && r.contract_id);
  const contractIds = [...new Set(targets.map((r) => r.contract_id as string))];
  if (contractIds.length === 0) return;

  const [contractsRes, stmtsRes] = await Promise.all([
    supabase.from("contracts").select("id, status, start_date, end_date").in("id", contractIds),
    supabase
      .from("billing_statements")
      .select("id, contract_id, period_start, proforma_sent_at, gst_invoice_number, supplements_statement_id, billing_payments:billing_payments(id)")
      .in("contract_id", contractIds)
      .in("statement_type", ["usage", "combined"])
      .is("voided_at", null)
      .neq("status", "discarded"),
  ]);

  const contractById = new Map((contractsRes.data ?? []).map((c) => [c.id as string, c as NextRunContract]));

  // Same partition generateUsageStatements uses: only period_start = 1st of
  // the month counts as covering; a supplement marks its original topped up.
  type Stmt = { id: string; contract_id: string; period_start: string; proforma_sent_at: string | null; gst_invoice_number: string | null; supplements_statement_id: string | null; billing_payments: { id: string }[] };
  const stmts = (stmtsRes.data ?? []) as Stmt[];
  const supplementedIds = new Set(stmts.map((st) => st.supplements_statement_id).filter((id): id is string => !!id));
  const coverage = new Map<string, MonthCoverage>();
  for (const st of stmts) {
    if (st.supplements_statement_id || !st.period_start.endsWith("-01")) continue;
    const sent = !!st.proforma_sent_at || !!st.gst_invoice_number || (st.billing_payments?.length ?? 0) > 0;
    if (!sent) continue;
    const key = `${st.contract_id}:${Number(st.period_start.slice(0, 4))}-${Number(st.period_start.slice(5, 7))}`;
    const prev = coverage.get(key);
    coverage.set(key, { sent: true, supplemented: (prev?.supplemented ?? false) || supplementedIds.has(st.id) });
  }

  const today = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const r of targets) {
    const cid = r.contract_id as string;
    r.next_run = nextUsageRun({
      chargeDate: r.charge_date,
      held: !!r.held_at,
      reviewed: !!r.reviewed_at,
      contract: contractById.get(cid) ?? null,
      today,
      reviewAfterDays: USAGE_CHARGE_REVIEW_REQUIRED_AFTER_DAYS,
      coverageFor: (ym) => coverage.get(`${cid}:${ym.year}-${ym.month}`) ?? null,
    });
  }
}

/**
 * GET /api/usage-charges
 *
 * Merges three sources of logged usage into one list — ad-hoc charges
 * (usage_charges), print-quota entries (service_usage_records), and
 * facility/meeting-room entries (facility_usage_records) — so the Usage
 * Charges tab shows everything captured this period, billable or not,
 * instead of only the ad-hoc subset. Each source is fetched and normalized
 * separately (see normalize* above), merged, sorted by date, then paginated
 * in memory: three heterogeneous tables can't share one SQL query, and
 * usage volume at this scale (one coworking business) doesn't need true
 * cross-table pagination — a bounded per-source fetch is enough.
 *
 * Print/facility have no booking or lead concept of their own (only a
 * contract), so a booking_id/lead_id filter — which only makes sense for
 * ad-hoc charges — narrows the result to manual rows only.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "25");
  const contractId = searchParams.get("contract_id");
  const bookingId = searchParams.get("booking_id");
  const leadId = searchParams.get("lead_id");
  // Comma-separated to support "everything but pending" (billed,waived) for
  // the Billed History view — filtering that in SQL, before pagination,
  // avoids a client-side post-filter silently shrinking a page below its
  // stated size.
  const status = searchParams.get("status");
  const statuses = status ? status.split(",").filter(Boolean) : null;
  const dateFrom = searchParams.get("date_from");
  const dateTo = searchParams.get("date_to");

  // A safety cap per source — not true pagination, see doc comment above.
  const SOURCE_CAP = 500;

  let manualQuery = supabase
    .from("usage_charges")
    .select(
      "*, contract:contracts!usage_charges_contract_id_fkey(id, contract_number, billing_cycle), booking:bookings!usage_charges_booking_id_fkey(id, booking_number, booking_date, lead_id, guest_name, guest_email), lead:leads!usage_charges_lead_id_fkey(id, first_name, last_name, company), waived_by_user:users!usage_charges_waived_by_fkey(id, full_name, role)"
    );
  if (contractId) manualQuery = manualQuery.eq("contract_id", contractId);
  if (bookingId) manualQuery = manualQuery.eq("booking_id", bookingId);
  if (leadId) manualQuery = manualQuery.eq("lead_id", leadId);
  if (statuses) manualQuery = manualQuery.in("status", statuses);
  if (dateFrom) manualQuery = manualQuery.gte("charge_date", dateFrom);
  if (dateTo) manualQuery = manualQuery.lte("charge_date", dateTo);
  manualQuery = manualQuery
    .order("charge_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(SOURCE_CAP);

  // Print/facility usage can now be waived AND held too (see
  // 00559_service_facility_charge_waive.sql, 00563_usage_billing_engine.sql)
  // — only a booking/lead filter narrows to manual rows, since print/
  // facility have no booking or lead concept of their own.
  const manualOnly = !!bookingId || !!leadId;

  const [manualResult, printResult, facilityResult] = await Promise.all([
    manualQuery,
    manualOnly ? Promise.resolve({ data: [], error: null }) : (async () => {
      let q = supabase
        .from("service_usage_records")
        .select("id, contract_id, quantity_used, overage_quantity, overage_rate_snapshot, amount, gst_rate, gst_amount, total_with_gst, is_billed, period_year, period_month, notes, created_at, waived_at, waive_reason, held_at, hold_reason, reviewed_at, contract:contracts!service_usage_records_contract_id_fkey(id, contract_number, billing_cycle, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)), service:service_catalog(name), waived_by_user:users!service_usage_records_waived_by_fkey(id, full_name, role)")
        .not("contract_id", "is", null)
        .limit(SOURCE_CAP);
      if (contractId) q = q.eq("contract_id", contractId);
      // Only weigh in on is_billed/waived_at when the requested set names
      // exactly one status this table actually has; a set naming several
      // (or neither) is "show any," so no filter at all — the post-merge
      // filter below is the safety net either way.
      if (statuses?.length === 1 && statuses[0] === "waived") {
        q = q.not("waived_at", "is", null);
      } else if (statuses?.length === 1 && statuses[0] === "pending") {
        q = q.eq("is_billed", false).is("waived_at", null);
      } else if (statuses?.length === 1 && statuses[0] === "billed") {
        q = q.eq("is_billed", true);
      }
      return q;
    })(),
    manualOnly ? Promise.resolve({ data: [], error: null }) : (async () => {
      let q = supabase
        .from("facility_usage_records")
        .select("id, contract_id, quantity_used, billable_quantity, unit_price, total_charge, notes, created_at, waived_at, waive_reason, held_at, hold_reason, reviewed_at, billing_statement_id, contract:contracts!facility_usage_records_contract_id_fkey(id, contract_number, billing_cycle, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)), contract_facility:contract_facilities(name, unit), accounting_period:accounting_periods(year, month, status), waived_by_user:users!facility_usage_records_waived_by_fkey(id, full_name, role)")
        .limit(SOURCE_CAP);
      if (contractId) q = q.eq("contract_id", contractId);
      if (statuses?.length === 1 && statuses[0] === "waived") q = q.not("waived_at", "is", null);
      return q;
    })(),
  ]);

  if (manualResult.error) return NextResponse.json({ error: manualResult.error.message }, { status: 500 });
  if (printResult.error) return NextResponse.json({ error: printResult.error.message }, { status: 500 });
  if (facilityResult.error) return NextResponse.json({ error: facilityResult.error.message }, { status: 500 });

  let merged: NormalizedRow[] = [
    ...(manualResult.data ?? []).map(normalizeManual),
    ...(printResult.data ?? []).map(normalizePrint),
    ...(facilityResult.data ?? []).map(normalizeFacility),
  ];

  // Print/facility status and date range couldn't be pushed into their SQL
  // queries (status is derived, date comes from a joined period) — apply
  // both post-merge instead.
  if (statuses) merged = merged.filter((r) => r.source === "manual" || statuses.includes(r.status));
  if (dateFrom) merged = merged.filter((r) => r.charge_date >= dateFrom);
  if (dateTo) merged = merged.filter((r) => r.charge_date <= dateTo);

  // charge_date has no time component, so tie-break same-day rows by
  // created_at (a real timestamp) for stable, chronological ordering.
  merged.sort((a, b) => b.charge_date.localeCompare(a.charge_date) || (b.created_at ?? "").localeCompare(a.created_at ?? ""));

  const total = merged.length;
  const offset = (page - 1) * limit;
  const data = merged.slice(offset, offset + limit);

  // Only the page actually being returned needs the covering-statement check
  // — cheap even though it's a second round trip, since it's scoped to just
  // this page's contracts.
  const pendingContractIds = [...new Set(data.filter((r) => r.status === "pending" && r.contract_id).map((r) => r.contract_id as string))];
  const coveringPeriods = await fetchCoveringPeriods(supabase, pendingContractIds);
  if (coveringPeriods.size > 0) {
    for (const row of data) {
      if (row.status !== "pending" || !row.contract_id) continue;
      const hasCovering = coveringPeriods.has(`${row.contract_id}:${row.charge_date.slice(0, 7)}`);
      if (hasCovering) {
        const cycle = billingCycleOf(row.charge_date, row.status, true);
        row.billing_cycle_status = cycle.status;
        row.billing_cycle_label = cycle.label;
      }
    }
  }

  await attachNextRun(supabase, data);

  return NextResponse.json({
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const result = createUsageChargeSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.issues }, { status: 400 });
  }

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();

  if (!dbUser || !CHARGE_ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json(
      { error: "You do not have permission to create usage charges" },
      { status: 403 }
    );
  }

  let leadId: string | null = null;

  // Derive the billing period from charge_date for lock/finalization checks
  const chargeDate = new Date(result.data.charge_date + "T00:00:00");
  const chargeMonth = chargeDate.getMonth() + 1;
  const chargeYear = chargeDate.getFullYear();
  const periodFirst = `${chargeYear}-${String(chargeMonth).padStart(2, "0")}-01`;
  const periodLast = `${chargeYear}-${String(chargeMonth).padStart(2, "0")}-${new Date(chargeYear, chargeMonth, 0).getDate()}`;
  const monthLabel = chargeDate.toLocaleString("en-IN", { month: "long", year: "numeric" });

  // Check if the accounting period is locked
  const { data: period } = await supabase
    .from("accounting_periods")
    .select("id, status")
    .eq("year", chargeYear)
    .eq("month", chargeMonth)
    .maybeSingle();

  if (period?.status === "locked") {
    return NextResponse.json(
      { error: `The ${monthLabel} billing period is locked. Charges cannot be added to a locked period.` },
      { status: 400 },
    );
  }

  // Will hold the contract's tax_percentage when creating a contract-based
  // charge — used below to override the client-supplied gst_rate so per-charge
  // GST always matches the statement-level rate.
  let contractTaxPercentage: number | null = null;
  let contractNumber: string | null = null;

  // Defaults to the client-supplied values; overwritten below when
  // contract_facility_id is set, since quota math is server-authoritative.
  //
  // The total is derived rather than trusted, for the same reason gst_amount is
  // below: a client that sends a total disagreeing with quantity x unit_price
  // leaves a line that cannot be read back. Booking TWV-B-0040 is the example —
  // three hours of conference room were billed correctly at Rs 2,400, but the
  // charge was stored as quantity 1 at Rs 800, so the line reads as Rs 800 while
  // charging Rs 2,400. Both dialogs already send quantity x unit_price, so this
  // changes nothing for them and only rejects the inconsistent case.
  let facilityQuantity  = result.data.quantity;
  let facilityUnitPrice = result.data.unit_price;
  let facilityTotal     = parseFloat((result.data.quantity * result.data.unit_price).toFixed(2));

  const claimedTotal = Number(result.data.total);
  if (Number.isFinite(claimedTotal) && Math.abs(claimedTotal - facilityTotal) > 0.01) {
    return NextResponse.json({
      error: `Charge does not add up: ${result.data.quantity} x ${result.data.unit_price} is ${facilityTotal.toLocaleString("en-IN")}, but the total says ${claimedTotal.toLocaleString("en-IN")}. Set the quantity to the units actually being billed.`,
    }, { status: 422 });
  }
  let facilityStatus    = "pending";

  if (result.data.contract_id) {
    // Contract-based charge — must exist and be active
    const { data: contract, error: contractError } = await supabase
      .from("contracts")
      .select("id, lead_id, status, end_date, tax_percentage, contract_number")
      .eq("id", result.data.contract_id)
      .single();

    if (contractError || !contract) {
      return NextResponse.json({ error: "Contract not found" }, { status: 404 });
    }
    if (!isContractOperational(contract)) {
      return NextResponse.json({ error: "Contract is not active" }, { status: 400 });
    }

    // A finalized/exported statement already covering this contract+period no
    // longer blocks the charge outright — it saves normally (pending, unlinked)
    // and the next "Generate Drafts" run picks it up as a SUPPLEMENTAL
    // statement topping up the original, instead of it having nowhere to go.
    // See generateUsageStatements in src/lib/billing.ts for the generation
    // side of this. The accounting-period lock above is unaffected — that's
    // a deliberate whole-month freeze, unrelated to this per-statement check.
    leadId = contract.lead_id;
    contractTaxPercentage = contract.tax_percentage != null ? Number(contract.tax_percentage) : null;
    contractNumber = contract.contract_number ?? null;

    // ── Facility-linked charge: quota is authoritative server-side ──────────
    // The client may pre-fill/override description + rate from the facility's
    // config, but quantity/total are always recomputed here against
    // free_quota + prior consumption this month — mirrors the booking-side
    // quota logic in /api/bookings (contractFacilityForQuota).
    if (result.data.contract_facility_id) {
      const { data: facility, error: facilityError } = await supabase
        .from("contract_facilities")
        .select("id, contract_id, name, free_quota, cost_per_unit, is_active")
        .eq("id", result.data.contract_facility_id)
        .eq("contract_id", result.data.contract_id)
        .single();

      if (facilityError || !facility) {
        return NextResponse.json({ error: "Facility not found on this contract" }, { status: 404 });
      }

      const { data: existingCharges } = await supabase
        .from("usage_charges")
        .select("quantity")
        .eq("contract_facility_id", facility.id)
        .is("billing_statement_id", null)
        .in("status", ["pending", "waived"])
        .gte("charge_date", periodFirst)
        .lte("charge_date", periodLast);

      const consumed = (existingCharges || []).reduce((sum, c) => sum + Number(c.quantity || 0), 0);
      const freeRemaining = Math.max(0, Number(facility.free_quota) - consumed);
      const requestedQty = Number(result.data.quantity);
      const overageQty = Math.max(0, requestedQty - freeRemaining);
      const rate = Number(result.data.unit_price);

      if (overageQty > 0) {
        facilityQuantity = overageQty;
        facilityUnitPrice = rate;
        facilityTotal = parseFloat((overageQty * rate).toFixed(2));
        facilityStatus = "pending";
      } else {
        facilityQuantity = requestedQty;
        facilityUnitPrice = 0;
        facilityTotal = 0;
        facilityStatus = "waived";
      }
    }
  } else if (result.data.booking_id) {
    // Booking-based charge — booking must exist
    const { data: booking, error: bookingError } = await supabase
      .from("bookings")
      .select("id, lead_id, status")
      .eq("id", result.data.booking_id)
      .single();

    if (bookingError || !booking) {
      return NextResponse.json({ error: "Booking not found" }, { status: 404 });
    }
    leadId = booking.lead_id ?? null;
  }

  // A charge that nets to zero (e.g. a complimentary/courtesy booking add-on
  // entered at quantity x price = 0) has nothing to bill — treat it the same
  // as the facility-quota "within free quota" case above: waived, not
  // pending, so it doesn't sit in the usage-gap queue forever waiting for a
  // statement it will never need (see getUsageGaps in unbilled-queue.ts).
  if (facilityStatus === "pending" && facilityTotal === 0) {
    facilityStatus = "waived";
  }

  // GST: server is the source of truth for the computed fields.
  // For contract-based charges, force gst_rate to match the contract's
  // tax_percentage so every line item on the billing statement uses the
  // same rate. This prevents the mismatch where a charge is stored at 5%
  // but the statement-level total applies 18%. For non-contract charges
  // (booking-based), the client-supplied rate (default 18%) is used.
  const gstRate = contractTaxPercentage ?? result.data.gst_rate ?? 18;
  const subtotal = facilityTotal;
  const gstAmount = parseFloat((subtotal * gstRate / 100).toFixed(2));
  const totalWithGst = parseFloat((subtotal + gstAmount).toFixed(2));

  const { data, error } = await supabase
    .from("usage_charges")
    .insert({
      contract_id: result.data.contract_id ?? null,
      booking_id: result.data.booking_id ?? null,
      contract_facility_id: result.data.contract_facility_id ?? null,
      description: result.data.description,
      quantity: facilityQuantity,
      unit_price: facilityUnitPrice,
      total: subtotal,
      gst_rate: gstRate,
      gst_amount: gstAmount,
      total_with_gst: totalWithGst,
      charge_date: result.data.charge_date,
      hsn_sac_code: result.data.hsn_sac_code || "999799",
      notes: result.data.notes,
      proof_path: body.proof_path || null,
      lead_id: leadId,
      status: facilityStatus,
      created_by: dbUser?.id,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (data && dbUser?.id) {
    logAudit(supabase, {
      entityType: "usage_charge",
      entityId: data.id,
      action: "create",
      performedBy: dbUser.id,
      changes: { record: { old: null, new: data } },
    });
  }

  const chargeRef = contractNumber ? `contract ${contractNumber}` : "the booking";
  const amountLine = `Qty ${facilityQuantity} × ₹${facilityUnitPrice} = ₹${subtotal}${gstAmount > 0 ? ` + ₹${gstAmount} GST = ₹${totalWithGst}` : ""}`;

  const postInsertTasks: PromiseLike<unknown>[] = [];

  // Surface every ad-hoc charge on the customer's Activities timeline (not
  // just the admin-only audit log) so staff reviewing a lead/contract can
  // see it without digging into Billing.
  if (data && leadId && dbUser?.id) {
    postInsertTasks.push(
      supabase.from("activities").insert({
        lead_id: leadId,
        type: "note",
        subject: `Charge added — ₹${totalWithGst}`,
        description: `${result.data.description} (${amountLine}) on ${chargeRef}. Will be billed in the ${monthLabel} cycle.`,
        created_by: dbUser.id,
      }).then(({ error: activityError }) => {
        if (activityError) console.error("[usage-charge activity]", activityError.message);
      })
    );
  }

  // Optional customer notification — staff explicitly opts in per charge.
  // WhatsApp/SMS aren't available here: this app only sends pre-approved
  // MSG91 templates and none exists for an ad-hoc charge notice, so email
  // is the only channel wired up today.
  if (data && leadId && body.notify_customer === true) {
    postInsertTasks.push(
      (async () => {
        const { data: leadRow } = await supabase
          .from("leads")
          .select("email, billing_emails, first_name, last_name, company")
          .eq("id", leadId)
          .single();

        const recipients = Array.from(
          new Set([leadRow?.email, ...((leadRow?.billing_emails as string[] | null) ?? [])].filter(Boolean))
        ) as string[];

        if (recipients.length === 0) {
          console.error("[usage-charge notify] no email on file for lead", leadId);
          return;
        }

        const customerName = leadRow?.company || `${leadRow?.first_name ?? ""} ${leadRow?.last_name ?? ""}`.trim() || "there";

        const html = `
          <p>Hi ${customerName},</p>
          <p>A new charge has been added to your account on ${chargeRef}:</p>
          <table style="border-collapse:collapse;margin:12px 0">
            <tr><td style="padding:4px 12px 4px 0;color:#666">Description</td><td>${result.data.description}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666">Amount</td><td>${amountLine}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666">Date</td><td>${result.data.charge_date}</td></tr>
          </table>
          <p>This will be billed at the end of the ${monthLabel} billing cycle along with your regular statement.</p>
          <p style="font-size:12px;color:#888">If you believe this charge was made in error, please reply to this email or contact us within 24 hours so we can review it before it's billed.</p>
        `;

        try {
          const sendResult = await resend.emails.send({
            from: EMAIL_FROM,
            to: recipients,
            replyTo: EMAIL_REPLY_TO,
            subject: `New charge added — ${chargeRef}`,
            html,
          });
          if (sendResult.error) {
            console.error("[usage-charge notify] send failed", sendResult.error.message);
          }
        } catch (sendErr) {
          console.error("[usage-charge notify] send threw", sendErr instanceof Error ? sendErr.message : sendErr);
        }
      })()
    );
  }

  await Promise.all(postInsertTasks);

  return NextResponse.json({ data }, { status: 201 });
}
