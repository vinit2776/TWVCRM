import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Use admin client to bypass RLS for accounting reads
  const adminSupabase = await createAdminClient();

  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get("year") || new Date().getFullYear().toString());
  const month = parseInt(searchParams.get("month") || (new Date().getMonth() + 1).toString());

  // Compute period date range
  const periodStart = new Date(year, month - 1, 1).toISOString().split("T")[0];
  const periodEnd = new Date(year, month, 0).toISOString().split("T")[0]; // Last day of month

  // ── Step 1: Get or create accounting period ─────────────────────────
  let { data: period } = await adminSupabase
    .from("accounting_periods")
    .select("*, locker:users!accounting_periods_locked_by_fkey(id, full_name)")
    .eq("year", year)
    .eq("month", month)
    .single();

  if (!period) {
    const { data: newPeriod } = await adminSupabase
      .from("accounting_periods")
      .insert({ year, month, status: "open" })
      .select("*, locker:users!accounting_periods_locked_by_fkey(id, full_name)")
      .single();
    period = newPeriod;
  }

  // ── Step 2: Get all active contracts for this period ─────────────────
  const { data: contracts } = await adminSupabase
    .from("contracts")
    .select(
      "id, contract_number, title, status, start_date, seats, total_amount, billing_cycle, tenure_months, lead:leads!contracts_lead_id_fkey(id, first_name, last_name, company, email, secondary_email)"
    )
    .lte("start_date", periodEnd)
    .in("status", ["active", "renewal_in_progress"]);

  // Filter contracts actually active during this period
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeContracts = (contracts || []).filter((c: any) => {
    const startDate = new Date(c.start_date);
    const endDate = new Date(startDate);
    endDate.setMonth(endDate.getMonth() + c.tenure_months);
    const endDateStr = endDate.toISOString().split("T")[0];
    return endDateStr >= periodStart;
  });

  const contractIds = activeContracts.map((c) => c.id);

  // ── Single batch: ALL 12 queries in parallel ─────────────────────────
  // Current-period data (7 queries) + carry-forward data (5 queries)
  // all depend only on contractIds + period.id — neither set depends on
  // the other's results, so they all fire in one Promise.all. billing_payments
  // for prior statements runs as a 13th query after this (needs statement IDs).

  const hasContracts = contractIds.length > 0;
  const [
    { data: facilityUsages },
    { data: contractPayments },
    { data: generalPayments },
    { data: usageCharges },
    { data: postedBookings },
    { data: billingStatements },
    { data: walkinPayments },
    { data: priorPayments },
    { data: priorUsages },
    { data: priorPeriods },
    { data: priorAdHoc },
    { data: priorBillingStatements },
  ] = await Promise.all([
    // ── Current-period queries ──
    // 3. Facility usage records
    period?.id
      ? adminSupabase
          .from("facility_usage_records")
          .select(
            "*, contract_facility:contract_facilities!facility_usage_records_contract_facility_id_fkey(id, name, unit, cost_per_unit, free_quota)"
          )
          .eq("accounting_period_id", period.id)
      : Promise.resolve({ data: [] }),
    // 4. Contract payments for this period
    period?.id
      ? adminSupabase
          .from("contract_payments")
          .select(
            "*, creator:users!contract_payments_created_by_fkey(id, full_name), collector:users!contract_payments_collected_by_fkey(id, full_name)"
          )
          .eq("accounting_period_id", period.id)
      : Promise.resolve({ data: [] }),
    // 5. General payments (linked to contracts, no period)
    hasContracts
      ? adminSupabase
          .from("contract_payments")
          .select(
            "*, creator:users!contract_payments_created_by_fkey(id, full_name), collector:users!contract_payments_collected_by_fkey(id, full_name)"
          )
          .in("contract_id", contractIds)
          .is("accounting_period_id", null)
          .gte("payment_date", periodStart)
          .lte("payment_date", periodEnd)
      : Promise.resolve({ data: [] }),
    // 6a. Ad-hoc usage charges
    hasContracts
      ? adminSupabase
          .from("usage_charges")
          .select("*")
          .in("contract_id", contractIds)
          .gte("charge_date", periodStart)
          .lte("charge_date", periodEnd)
      : Promise.resolve({ data: [] }),
    // 6b. Bookings posted to bill — exclude bookings already linked to a
    //     billing statement (billing.ts sets billing_statement_id when it
    //     includes a booking in a statement, so these are already billed)
    hasContracts
      ? adminSupabase
          .from("bookings")
          .select("*, space:spaces!bookings_space_id_fkey(id, name)")
          .in("contract_id", contractIds)
          .eq("payment_status", "posted_to_bill")
          .is("billing_statement_id", null)
          .gte("booking_date", periodStart)
          .lte("booking_date", periodEnd)
      : Promise.resolve({ data: [] }),
    // 6c. Billing statement status per contract (full lifecycle fields for merged view)
    hasContracts
      ? adminSupabase
          .from("billing_statements")
          .select("id, contract_id, status, statement_number, total_amount, fixed_amount, usage_amount, booking_usage_amount, finalized_at, proforma_sent_at, gst_invoice_number, payment_status, accounted, accounted_at, razorpay_payment_link_url, emailed_at, issuance_channel, lifecycle_stage, tally_invoice_number, tally_irn, tally_credit_note_number, tally_last_error, tally_delivered_at, finalized_by_user:users!billing_statements_finalized_by_fkey(full_name), proforma_sent_by_user:users!billing_statements_proforma_sent_by_fkey(full_name), gst_generated_by_user:users!billing_statements_gst_generated_by_fkey(full_name), accounted_by_user:users!billing_statements_accounted_by_fkey(full_name), billing_payments(id, amount, payment_date, payment_mode, payment_reference, razorpay_payment_id, recorded_by_user:users!billing_payments_recorded_by_fkey(full_name))")
          .in("contract_id", contractIds)
          .gte("period_start", periodStart)
          .lte("period_start", periodEnd)
      : Promise.resolve({ data: [] }),
    // 7. Walk-in booking payments
    adminSupabase
      .from("booking_payments")
      .select(
        "*, booking:bookings!booking_payments_booking_id_fkey(id, booking_number, booking_date, space:spaces!bookings_space_id_fkey(id, name), lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company), guest_name, guest_company, customer_type)"
      )
      .gte("created_at", `${periodStart}T00:00:00`)
      .lte("created_at", `${periodEnd}T23:59:59`),
    // ── Carry-forward queries ──
    // 8. Prior verified payments (from go-live onwards, before this period)
    hasContracts
      ? adminSupabase
          .from("contract_payments")
          .select("contract_id, amount, status")
          .in("contract_id", contractIds)
          .eq("status", "verified")
          .gte("payment_date", "2026-05-01")
          .lt("payment_date", periodStart)
      : Promise.resolve({ data: [] }),
    // 9. All facility usage records (for prior periods)
    hasContracts
      ? adminSupabase
          .from("facility_usage_records")
          .select("contract_id, total_charge, accounting_period_id")
          .in("contract_id", contractIds)
      : Promise.resolve({ data: [] }),
    // 10. Prior accounting periods
    adminSupabase
      .from("accounting_periods")
      .select("id, year, month")
      .or(`year.lt.${year},and(year.eq.${year},month.lt.${month})`),
    // 11. Prior ad-hoc charges (only from go-live onwards) — kept for fallback path
    hasContracts
      ? adminSupabase
          .from("usage_charges")
          .select("contract_id, total")
          .in("contract_id", contractIds)
          .gte("charge_date", "2026-05-01")
          .lt("charge_date", periodStart)
      : Promise.resolve({ data: [] }),
    // 12. Prior finalized billing statements (go-live onwards, before this period).
    // Used as the primary carry-forward source: the statement's total_amount is the
    // ground truth for what was billed, matching the AR view exactly. This avoids
    // double-counting facility_usage_records that were already included in the statement.
    hasContracts
      ? adminSupabase
          .from("billing_statements")
          .select("id, contract_id, total_amount")
          .in("contract_id", contractIds)
          .in("status", ["finalized", "exported"])
          .is("voided_at", null)
          .gte("period_start", "2026-05-01")
          .lt("period_start", periodStart)
      : Promise.resolve({ data: [] }),
  ]);

  // ── Fetch billing_payments for prior statements (needs their IDs) ─────
  const priorStatementIds = (priorBillingStatements || []).map((s) => s.id as string);
  let priorBillingPmts: { billing_statement_id: string; amount: number }[] = [];
  if (priorStatementIds.length > 0) {
    const { data } = await adminSupabase
      .from("billing_payments")
      .select("billing_statement_id, amount")
      .in("billing_statement_id", priorStatementIds);
    priorBillingPmts = data || [];
  }

  const allPaymentsThisMonth = [...(contractPayments || []), ...(generalPayments || [])];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const statementByContract: Record<string, any> = {};
  (billingStatements || []).forEach((s) => {
    if (s.contract_id) statementByContract[s.contract_id] = s;
  });

  // ── Carry-forward computation ──────────────────────────────────────
  //
  // Primary path (statement-based): when a finalized billing statement exists
  // for a prior period, use statement.total_amount − billing_payments as the
  // carry-forward. This is the same number the AR view shows and avoids
  // double-counting facility_usage_records that were already included in the
  // statement total.
  //
  // Fallback path (recalculation): for contracts with no prior finalized
  // statement (e.g. billing cron missed, or contract just started), fall back
  // to months × contract.total_amount + unbilled usage − contract_payments.
  const carryForwardByContract: Record<string, number> = {};
  if (hasContracts) {

    // Index prior statements by contract
    const priorStmtsByContract: Record<string, { id: string; total: number }[]> = {};
    (priorBillingStatements || []).forEach((s) => {
      if (!priorStmtsByContract[s.contract_id]) priorStmtsByContract[s.contract_id] = [];
      priorStmtsByContract[s.contract_id].push({ id: s.id as string, total: Number(s.total_amount) });
    });

    // Index billing_payments by statement id
    const priorBillingPmtsByStmt: Record<string, number> = {};
    priorBillingPmts.forEach((p) => {
      priorBillingPmtsByStmt[p.billing_statement_id] = (priorBillingPmtsByStmt[p.billing_statement_id] || 0) + Number(p.amount);
    });

    // contract_payments from prior periods (legacy payment path)
    const priorPaymentsByContract: Record<string, number> = {};
    (priorPayments || []).forEach((p) => {
      priorPaymentsByContract[p.contract_id] = (priorPaymentsByContract[p.contract_id] || 0) + Number(p.amount);
    });

    // ── Go-live anchor (fallback path only) ─────────────────────────────
    const BILLING_GO_LIVE = new Date(2026, 4, 1); // May 1 2026 (month is 0-indexed)
    const GO_LIVE_YEAR = 2026;
    const GO_LIVE_MONTH = 5;

    const validPriorPeriodIds = new Set(
      (priorPeriods || [])
        .filter(p => p.year > GO_LIVE_YEAR || (p.year === GO_LIVE_YEAR && p.month >= GO_LIVE_MONTH))
        .map(p => p.id)
    );

    const priorUsageByContract: Record<string, number> = {};
    (priorUsages || []).forEach((u) => {
      if (validPriorPeriodIds.has(u.accounting_period_id)) {
        priorUsageByContract[u.contract_id] = (priorUsageByContract[u.contract_id] || 0) + Number(u.total_charge);
      }
    });

    const priorAdHocByContract: Record<string, number> = {};
    (priorAdHoc || []).forEach((c) => {
      priorAdHocByContract[c.contract_id] = (priorAdHocByContract[c.contract_id] || 0) + Number(c.total);
    });

    activeContracts.forEach((contract) => {
      const stmts = priorStmtsByContract[contract.id];

      if (stmts && stmts.length > 0) {
        // ── Primary: statement-based ──────────────────────────────────
        // Sum unpaid balances across all prior finalized statements.
        // Matches the AR view exactly; no risk of double-counting usage.
        const statementBalance = stmts.reduce((sum, s) => {
          const paid = priorBillingPmtsByStmt[s.id] || 0;
          return sum + Math.max(0, s.total - paid);
        }, 0);
        // Subtract any direct contract_payments not tied to a statement
        const directPaid = priorPaymentsByContract[contract.id] || 0;
        carryForwardByContract[contract.id] = Math.max(0, statementBalance - directPaid);
      } else {
        // ── Fallback: recalculate from contract monthly amount ─────────
        const contractStart = new Date(contract.start_date);
        const thisMonthStart = new Date(year, month - 1, 1);
        const countFrom = contractStart > BILLING_GO_LIVE ? contractStart : BILLING_GO_LIVE;
        let monthsBeforeThisPeriod = 0;
        const cursor = new Date(countFrom.getFullYear(), countFrom.getMonth(), 1);
        while (cursor < thisMonthStart) {
          monthsBeforeThisPeriod++;
          cursor.setMonth(cursor.getMonth() + 1);
        }
        const totalRecurringBefore = monthsBeforeThisPeriod * Number(contract.total_amount);
        const totalChargesBefore =
          totalRecurringBefore +
          (priorUsageByContract[contract.id] || 0) +
          (priorAdHocByContract[contract.id] || 0);
        const totalPaidBefore = priorPaymentsByContract[contract.id] || 0;
        carryForwardByContract[contract.id] = Math.max(0, totalChargesBefore - totalPaidBefore);
      }
    });
  }

  // ── Build per-contract summaries ────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contractSummaries = activeContracts.map((contract: any) => {
    const contractFacilityUsages = (facilityUsages || []).filter((u) => u.contract_id === contract.id);
    const contractAdHocCharges = (usageCharges || []).filter((c) => c.contract_id === contract.id);
    const contractBookings = (postedBookings || []).filter((b) => b.contract_id === contract.id);
    const contractPmts = allPaymentsThisMonth.filter((p) => p.contract_id === contract.id);

    const facilityUsageTotal = contractFacilityUsages.reduce((sum, u) => sum + Number(u.total_charge), 0);
    const adHocTotal = contractAdHocCharges.reduce((sum, c) => sum + Number(c.total), 0);
    const bookingTotal = contractBookings.reduce((sum, b) => sum + Number(b.total_amount || 0), 0);
    const recurringAmount = Number(contract.total_amount);
    const currentMonthCharges = recurringAmount + facilityUsageTotal + adHocTotal + bookingTotal;

    const verifiedPayments = contractPmts.filter((p) => p.status === "verified");
    const totalPaidThisMonth = verifiedPayments.reduce((sum, p) => sum + Number(p.amount), 0);

    const carriedForward = carryForwardByContract[contract.id] || 0;
    const totalOwed = carriedForward + currentMonthCharges;
    const outstanding = Math.max(0, totalOwed - totalPaidThisMonth);

    // Find GST invoice info from payments
    const gstPayment = contractPmts.find((p) => p.gst_invoice_number || p.gst_invoice_path);

    return {
      contract,
      recurring_amount: recurringAmount,
      facility_usage_total: facilityUsageTotal,
      facility_usages: contractFacilityUsages,
      ad_hoc_total: adHocTotal,
      ad_hoc_charges: contractAdHocCharges,
      booking_total: bookingTotal,
      posted_bookings: contractBookings,
      current_month_charges: currentMonthCharges,
      carried_forward: carriedForward,
      total_owed: totalOwed,
      payments: contractPmts,
      total_paid_this_month: totalPaidThisMonth,
      outstanding,
      billing_statement: statementByContract[contract.id as string] || null,
      gst_invoice: gstPayment
        ? {
            number: gstPayment.gst_invoice_number,
            path: gstPayment.gst_invoice_path,
            status: gstPayment.gst_invoice_status,
            sent_at: gstPayment.gst_invoice_sent_at,
            sent_to: gstPayment.gst_invoice_sent_to,
          }
        : null,
    };
  });

  // ── Aging buckets ───────────────────────────────────────────────────
  const today = new Date();
  const agingBuckets = {
    current: { count: 0, total: 0, contracts: [] as string[] },
    overdue_30: { count: 0, total: 0, contracts: [] as string[] },
    overdue_60: { count: 0, total: 0, contracts: [] as string[] },
    overdue_90: { count: 0, total: 0, contracts: [] as string[] },
  };

  contractSummaries.forEach((cs) => {
    if (cs.outstanding <= 0) return;

    const currentOutstanding = Math.max(0, cs.current_month_charges - cs.total_paid_this_month);
    if (currentOutstanding > 0) {
      agingBuckets.current.count++;
      agingBuckets.current.total += currentOutstanding;
      agingBuckets.current.contracts.push(cs.contract.id);
    }

    if (cs.carried_forward > 0) {
      const monthsAgo1Start = new Date(year, month - 2, 1);
      const diffMonths = (today.getFullYear() - monthsAgo1Start.getFullYear()) * 12 +
        (today.getMonth() - monthsAgo1Start.getMonth());

      if (diffMonths <= 1) {
        agingBuckets.overdue_30.count++;
        agingBuckets.overdue_30.total += cs.carried_forward;
        agingBuckets.overdue_30.contracts.push(cs.contract.id);
      } else if (diffMonths <= 2) {
        agingBuckets.overdue_60.count++;
        agingBuckets.overdue_60.total += cs.carried_forward;
        agingBuckets.overdue_60.contracts.push(cs.contract.id);
      } else {
        agingBuckets.overdue_90.count++;
        agingBuckets.overdue_90.total += cs.carried_forward;
        agingBuckets.overdue_90.contracts.push(cs.contract.id);
      }
    }
  });

  // ── Cash handover summary ──────────────────────────────────────────
  const cashPayments = allPaymentsThisMonth.filter((p) => p.payment_mode === "cash");
  const cashPendingHandover = cashPayments
    .filter((p) => p.cash_handover_status === "pending_handover")
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const cashHandedOver = cashPayments
    .filter((p) => p.cash_handover_status === "handed_over")
    .reduce((sum, p) => sum + Number(p.amount), 0);

  const walkinCashPayments = (walkinPayments || []).filter((p) => p.payment_mode === "cash");
  const walkinCashPending = walkinCashPayments
    .filter((p) => p.cash_handover_status === "pending_handover")
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const walkinCashHandedOver = walkinCashPayments
    .filter((p) => p.cash_handover_status === "handed_over")
    .reduce((sum, p) => sum + Number(p.amount), 0);

  // ── Grand totals ───────────────────────────────────────────────────
  const totalBillable = contractSummaries.reduce((sum, cs) => sum + cs.current_month_charges, 0);
  const totalCollected = contractSummaries.reduce((sum, cs) => sum + cs.total_paid_this_month, 0);
  const totalOutstanding = contractSummaries.reduce((sum, cs) => sum + cs.outstanding, 0);
  const totalCarriedForward = contractSummaries.reduce((sum, cs) => sum + cs.carried_forward, 0);

  return NextResponse.json({
    data: {
      period,
      year,
      month,
      period_start: periodStart,
      period_end: periodEnd,
      contracts: contractSummaries,
      walkin_payments: walkinPayments || [],
      totals: {
        total_billable: totalBillable,
        total_collected: totalCollected,
        total_outstanding: totalOutstanding,
        total_carried_forward: totalCarriedForward,
        cash_pending_handover: cashPendingHandover + walkinCashPending,
        cash_handed_over: cashHandedOver + walkinCashHandedOver,
      },
      aging_buckets: agingBuckets,
    },
  });
}
