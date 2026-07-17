import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { pingCronHealth } from "@/lib/cron-ping";
import { paymentCredit, balanceDue } from "@/lib/settlement";
import { summarizeAuditEvent } from "@/lib/audit-labels";

export const maxDuration = 60;

/**
 * GET /api/digest
 * Daily business digest email — triggered by Vercel cron at 8:30 PM IST.
 * Also supports ?date=YYYY-MM-DD for on-demand generation.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // Default to today in IST (UTC+5:30)
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const todayIST = searchParams.get("date") || istNow.toISOString().slice(0, 10);

  // Comparison dates
  const todayDate = new Date(todayIST + "T00:00:00Z");
  const lastWeekDate = new Date(todayDate.getTime() - 7 * 86400000);
  const lastYearDate = new Date(todayDate);
  lastYearDate.setFullYear(lastYearDate.getFullYear() - 1);

  const lastWeek = lastWeekDate.toISOString().slice(0, 10);
  const lastYear = lastYearDate.toISOString().slice(0, 10);

  // Week-to-date: Monday of the current IST week → today
  const dayOfWeek = todayDate.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(todayDate.getTime() - daysFromMonday * 86400000)
    .toISOString()
    .slice(0, 10);

  const supabase = await createAdminClient();

  // Recipients — every active admin, resolved fresh on each send so the list
  // never drifts from who actually holds the role (previously a manually
  // maintained app_settings list, which had gone stale). Other crons still
  // read the static `digest_recipients` setting independently — unaffected.
  const { data: admins } = await supabase
    .from("users")
    .select("email")
    .eq("role", "admin")
    .eq("is_active", true);

  const recipients = (admins || [])
    .map((u: { email: string }) => u.email)
    .filter(Boolean);

  if (recipients.length === 0) {
    return NextResponse.json({ error: "No active admin recipients found" }, { status: 400 });
  }

  // Aggregate data for 3 date windows + week-to-date
  const [today, lw, ly, wtd] = await Promise.all([
    fetchMetrics(supabase, todayIST),
    fetchMetrics(supabase, lastWeek),
    fetchMetrics(supabase, lastYear),
    fetchMetricsRange(supabase, weekStart, todayIST),
  ]);

  // Yesterday in IST
  const yesterdayDate = new Date(todayDate.getTime() - 86400000);
  const yesterdayIST = yesterdayDate.toISOString().slice(0, 10);

  // Today-only: location breakdown, attention items, portfolio snapshot, extended data
  const [locations, attention, portfolio, extended, receivables, yesterday, yesterdayLocations, storyboard] = await Promise.all([
    fetchLocationBreakdown(supabase, todayIST),
    fetchAttentionItems(supabase, todayIST),
    fetchPortfolio(supabase),
    fetchExtended(supabase, todayIST),
    fetchReceivablesAging(supabase, todayIST),
    fetchMetrics(supabase, yesterdayIST),
    fetchLocationBreakdown(supabase, yesterdayIST),
    fetchStoryboardHighlights(supabase, todayIST),
  ]);

  // Build and send email
  const dateLabel = new Date(todayIST + "T00:00:00").toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const html = buildDigestHtml(dateLabel, todayIST, weekStart, yesterday, yesterdayIST, yesterdayLocations, today, lw, ly, wtd, locations, attention, portfolio, extended, receivables, storyboard);

  // ?preview=1 renders the HTML without sending — used for local/staging QA so
  // testing against real (prod) data never fans out real emails to recipients.
  if (searchParams.get("preview") === "1") {
    return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  let sent = 0;
  for (const email of recipients) {
    try {
      await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: [email],
        subject: `Daily Digest — ${dateLabel}`,
        html,
      });
      sent++;
    } catch (err) {
      console.error(`[digest] Failed to send to ${email}:`, err);
    }
  }

  await pingCronHealth("digest", "ok", { sent, recipients: recipients.length });

  return NextResponse.json({
    date: todayIST,
    recipients: recipients.length,
    sent,
    metrics: { today, weekToDate: wtd, lastWeek: lw, lastYear: ly },
    locations,
    attention,
    portfolio,
    extended,
    receivables,
  });
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

interface Metrics {
  collections: number;
  bookingRevenue: number;
  invoiceCount: number;
  invoiceAmount: number;
  pettyCashSpend: number;
  posRaised: number;
  poAmount: number;
  newLeads: number;
  leadsWon: number;
  leadsLost: number;
  activities: number;
  tasksCompleted: number;
  newBookings: number;
  newContracts: number;
  supportTickets: number;
  workOrdersOpened: number;
  workOrdersClosed: number;
}

/** Single-day shorthand — delegates to the range version */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchMetrics(supabase: any, date: string): Promise<Metrics> {
  return fetchMetricsRange(supabase, date, date);
}

/**
 * Aggregate metrics across an inclusive date range [fromDate … toDate].
 * Both dates are YYYY-MM-DD strings. Single-day: pass the same date for both.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchMetricsRange(supabase: any, fromDate: string, toDate: string): Promise<Metrics> {
  const rangeStart = `${fromDate}T00:00:00`;
  const rangeEnd = `${toDate}T23:59:59`;

  const [
    collections,
    billingCollections,
    bookingRevenue,
    invoices,
    pettyCash,
    pos,
    leads,
    leadsWon,
    leadsLost,
    activities,
    tasks,
    bookings,
    contracts,
    tickets,
    workOrdersOpened,
    workOrdersClosed,
  ] = await Promise.all([
    // Keyed on created_at (when the payment was recorded), not payment_date
    // (the receipt date the recorder enters, which can be backdated) — so a
    // manually-entered payment always surfaces in the digest for the day it
    // was actually logged, even if it's for an earlier receipt date.
    supabase
      .from("contract_payments")
      .select("amount")
      .eq("status", "verified")
      .gte("created_at", rangeStart)
      .lte("created_at", rangeEnd),
    supabase
      .from("billing_payments")
      .select("amount")
      .gte("created_at", rangeStart)
      .lte("created_at", rangeEnd),
    supabase
      .from("booking_payments")
      .select("amount")
      .eq("status", "verified")
      .gte("created_at", rangeStart)
      .lte("created_at", rangeEnd),
    supabase
      .from("proforma_invoices")
      .select("total_amount")
      .gte("created_at", rangeStart)
      .lte("created_at", rangeEnd),
    supabase
      .from("petty_cash_entries")
      .select("amount")
      .eq("status", "approved")
      .gte("date", fromDate)
      .lte("date", toDate),
    supabase
      .from("purchase_orders")
      .select("total_ordered_amount")
      .gte("created_at", rangeStart)
      .lte("created_at", rangeEnd),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .gte("created_at", rangeStart)
      .lte("created_at", rangeEnd),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .gte("converted_at", rangeStart)
      .lte("converted_at", rangeEnd),
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .gte("lost_at", rangeStart)
      .lte("lost_at", rangeEnd),
    supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .gte("created_at", rangeStart)
      .lte("created_at", rangeEnd),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .gte("completed_at", rangeStart)
      .lte("completed_at", rangeEnd),
    supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .gte("booking_date", fromDate)
      .lte("booking_date", toDate)
      .in("status", ["confirmed", "checked_in", "checked_out", "completed"]),
    supabase
      .from("contracts")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .gte("created_at", rangeStart)
      .lte("created_at", rangeEnd),
    supabase
      .from("support_tickets")
      .select("id", { count: "exact", head: true })
      .gte("created_at", rangeStart)
      .lte("created_at", rangeEnd),
    // Facility "Work Orders" — reported_at is the creation timestamp (no created_at column).
    supabase
      .from("facility_issues")
      .select("id", { count: "exact", head: true })
      .gte("reported_at", rangeStart)
      .lte("reported_at", rangeEnd),
    supabase
      .from("facility_issues")
      .select("id", { count: "exact", head: true })
      .gte("closed_at", rangeStart)
      .lte("closed_at", rangeEnd),
  ]);

  const sum = (rows: { amount?: number; total_amount?: number; total_ordered_amount?: number }[] | null, field: string) =>
    (rows || []).reduce((s, r) => s + Number((r as Record<string, unknown>)[field] || 0), 0);

  return {
    collections: sum(collections.data, "amount") + sum(billingCollections.data, "amount"),
    bookingRevenue: sum(bookingRevenue.data, "amount"),
    invoiceCount: (invoices.data || []).length,
    invoiceAmount: sum(invoices.data, "total_amount"),
    pettyCashSpend: sum(pettyCash.data, "amount"),
    posRaised: (pos.data || []).length,
    poAmount: sum(pos.data, "total_ordered_amount"),
    newLeads: leads.count || 0,
    leadsWon: leadsWon.count || 0,
    leadsLost: leadsLost.count || 0,
    activities: activities.count || 0,
    tasksCompleted: tasks.count || 0,
    newBookings: bookings.count || 0,
    newContracts: contracts.count || 0,
    supportTickets: tickets.count || 0,
    workOrdersOpened: workOrdersOpened.count || 0,
    workOrdersClosed: workOrdersClosed.count || 0,
  };
}

interface LocationRow {
  name: string;
  collections: number;
  leads: number;
  bookings: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchLocationBreakdown(supabase: any, date: string): Promise<LocationRow[]> {
  const dayStart = `${date}T00:00:00`;
  const dayEnd = `${date}T23:59:59`;

  const { data: locs } = await supabase
    .from("locations")
    .select("id, name")
    .eq("is_active", true)
    .order("name");

  if (!locs || locs.length === 0) return [];

  const locationIds = locs.map((l: { id: string; name: string }) => l.id);

  // Fetch payments, leads, and bookings for all locations in parallel using batched queries.
  // Payments are keyed on created_at (when recorded), not payment_date (the
  // possibly-backdated receipt date) — see fetchMetricsRange for why.
  const [paymentsRes, billingPaymentsRes, leadsRes, bookingsRes] = await Promise.all([
    supabase
      .from("contract_payments")
      .select("amount, contract:contracts!contract_payments_contract_id_fkey(location_id)")
      .eq("status", "verified")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd),
    supabase
      .from("billing_payments")
      .select("amount, billing_statement:billing_statements!billing_payments_billing_statement_id_fkey(contract:contracts!billing_statements_contract_id_fkey(location_id))")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd),
    supabase
      .from("leads")
      .select("location_id", { count: "exact", head: false })
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd)
      .in("location_id", locationIds),
    supabase
      .from("bookings")
      .select("location_id", { count: "exact", head: false })
      .eq("booking_date", date)
      .in("status", ["confirmed", "checked_in", "checked_out", "completed"])
      .in("location_id", locationIds),
  ]);

  // Group leads count by location_id
  const leadsCountByLocation: Record<string, number> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (leadsRes.data || []) as any[]) {
    const lid = row.location_id;
    leadsCountByLocation[lid] = (leadsCountByLocation[lid] || 0) + 1;
  }

  // Group bookings count by location_id
  const bookingsCountByLocation: Record<string, number> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (bookingsRes.data || []) as any[]) {
    const lid = row.location_id;
    bookingsCountByLocation[lid] = (bookingsCountByLocation[lid] || 0) + 1;
  }

  // Build results — payments are aggregated by location via the joined contract
  return locs.map((loc: { id: string; name: string }) => {
    const locPayments = (paymentsRes.data || []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p: any) => p.contract?.location_id === loc.id
    );
    const locBillingPayments = (billingPaymentsRes.data || []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p: any) => p.billing_statement?.contract?.location_id === loc.id
    );
    const colTotal =
      locPayments.reduce(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: number, r: any) => s + Number(r.amount || 0),
        0
      ) +
      locBillingPayments.reduce(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: number, r: any) => s + Number(r.amount || 0),
        0
      );

    return {
      name: loc.name,
      collections: colTotal,
      leads: leadsCountByLocation[loc.id] || 0,
      bookings: bookingsCountByLocation[loc.id] || 0,
    };
  });
}

interface UnpaidBill {
  invoice_number: string;
  vendor_name: string;
  total_amount: number;
  amount_paid: number;
  due_date: string | null;
  payment_status: string;
}

interface AttentionItems {
  overdueTasks: number;
  overdueTasksUrgent: number;
  unpaidBills: UnpaidBill[];
  unpaidBillsTotal: number;
  expiringContracts: number;
  pendingFollowups: number;
  workOrdersSlaAtRisk: number;
  workOrdersOpenCritical: number;
}

const OPEN_WORK_ORDER_STATUSES = ["new", "acknowledged", "in_progress", "reopened"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAttentionItems(supabase: any, date: string): Promise<AttentionItems> {
  const thirtyDaysOut = new Date(new Date(date).getTime() + 30 * 86400000)
    .toISOString()
    .slice(0, 10);

  const [overdue, bills, expiring, followups, workOrdersSla, workOrdersCritical] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, priority")
      .lt("due_date", date)
      .neq("status", "done"),
    supabase
      .from("vendor_bills")
      .select("invoice_number, total_amount, amount_paid, due_date, payment_status, vendor:procurement_vendors!vendor_bills_vendor_id_fkey(company_name)")
      .neq("payment_status", "paid")
      .order("due_date", { ascending: true }),
    supabase
      .from("contracts")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .lte("end_date", thirtyDaysOut)
      .gte("end_date", date),
    supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("is_follow_up_done", false)
      .not("follow_up_date", "is", null),
    // Open work orders already past their SLA target — `sla_breached` on the row
    // is only computed at resolve time, so an open-but-overdue issue needs its
    // own live comparison against sla_target_at, not that column.
    supabase
      .from("facility_issues")
      .select("id", { count: "exact", head: true })
      .in("status", OPEN_WORK_ORDER_STATUSES)
      .lt("sla_target_at", `${date}T23:59:59`),
    supabase
      .from("facility_issues")
      .select("id", { count: "exact", head: true })
      .in("status", OPEN_WORK_ORDER_STATUSES)
      .eq("priority", "critical"),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const overdueRows = (overdue.data || []) as any[];
  const overdueTasksUrgent = overdueRows.filter((t) => t.priority === "urgent" || t.priority === "high").length;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const billRows: UnpaidBill[] = (bills.data || []).map((b: any) => ({
    invoice_number: b.invoice_number || "—",
    vendor_name: b.vendor?.company_name || "Unknown",
    total_amount: Number(b.total_amount || 0),
    amount_paid: Number(b.amount_paid || 0),
    due_date: b.due_date,
    payment_status: b.payment_status,
  }));

  return {
    overdueTasks: overdueRows.length,
    overdueTasksUrgent,
    unpaidBills: billRows,
    unpaidBillsTotal: billRows.reduce((s, r) => s + (r.total_amount - r.amount_paid), 0),
    expiringContracts: expiring.count || 0,
    pendingFollowups: followups.count || 0,
    workOrdersSlaAtRisk: workOrdersSla.count || 0,
    workOrdersOpenCritical: workOrdersCritical.count || 0,
  };
}

interface Portfolio {
  activeContracts: number;
  totalMRR: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchPortfolio(supabase: any): Promise<Portfolio> {
  const { data: contracts } = await supabase
    .from("contracts")
    .select("monthly_membership_fee")
    .eq("status", "active");

  const rows = contracts || [];
  return {
    activeContracts: rows.length,
    totalMRR: rows.reduce(
      (s: number, r: { monthly_membership_fee: number }) =>
        s + Number(r.monthly_membership_fee || 0),
      0
    ),
  };
}

// ---------------------------------------------------------------------------
// Receivables aging — billing statements with unpaid payment_status
// ---------------------------------------------------------------------------

interface AgingBucket {
  count: number;
  amount: number;
}

interface ReceivablesAging {
  // Finalized statements only — these are actual receivables sent (or to be sent) to clients
  total: number;          // total outstanding (finalized only)
  count: number;          // number of unpaid finalized statements
  current: AgingBucket;  // 0-30 days since period_end
  d31_60: AgingBucket;   // 31-60 days
  d61_90: AgingBucket;   // 61-90 days
  d90plus: AgingBucket;  // 90+ days
  // Draft statements — generated but not yet sent to client; shown separately, not as overdue
  pendingFinalization: AgingBucket;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchReceivablesAging(supabase: any, date: string): Promise<ReceivablesAging> {
  // Aging buckets contain ONLY finalized statements — those are actual invoices communicated
  // to the client. Draft statements are internal working documents (not yet sent to client)
  // and must not appear as overdue; they are tracked separately as "pending finalization".
  // "exported" statements are excluded: GST generation requires payment_status="paid",
  // so exported always means fully settled.
  const { data: rows } = await supabase
    .from("billing_statements")
    .select("id, total_amount, period_end, status, payment_status")
    .in("status", ["draft", "finalized"])
    .neq("payment_status", "paid");

  // Aging measures the outstanding balance, not the full invoice total —
  // partial payments (including TDS deductions) reduce what's owed. Same
  // settlement definition as the payment route and the AR view. Drafts
  // can't carry payments, so only finalized rows need the lookup.
  const finalizedIds = (rows || [])
    .filter((r: { status: string }) => r.status === "finalized")
    .map((r: { id: string }) => r.id);
  const paidByStmt = new Map<string, number>();
  if (finalizedIds.length > 0) {
    const { data: pays } = await supabase
      .from("billing_payments")
      .select("billing_statement_id, amount, tds_amount")
      .in("billing_statement_id", finalizedIds);
    for (const p of pays || []) {
      paidByStmt.set(p.billing_statement_id, (paidByStmt.get(p.billing_statement_id) || 0) + paymentCredit(p));
    }
  }

  const now = new Date(date + "T23:59:59Z").getTime();

  const aging: ReceivablesAging = {
    total: 0, count: 0,
    current: { count: 0, amount: 0 },
    d31_60: { count: 0, amount: 0 },
    d61_90: { count: 0, amount: 0 },
    d90plus: { count: 0, amount: 0 },
    pendingFinalization: { count: 0, amount: 0 },
  };

  for (const row of (rows || []) as { id: string; total_amount: number; period_end: string; status: string; payment_status: string }[]) {
    const amount = row.status === "draft"
      ? Number(row.total_amount || 0)
      : balanceDue(row.total_amount, paidByStmt.get(row.id) || 0);

    if (row.status === "draft") {
      // Draft statements haven't been sent to the client yet — not overdue, just pending work.
      // Track them separately so the aging buckets only reflect real receivables.
      aging.pendingFinalization.count += 1;
      aging.pendingFinalization.amount += amount;
      continue;
    }

    // Finalized statement — aging measured from period_end (when billing cycle closed)
    const anchor = new Date(row.period_end + "T00:00:00Z").getTime();
    const days = Math.floor((now - anchor) / 86400000);

    aging.total += amount;
    aging.count += 1;

    if (days <= 30) {
      aging.current.count += 1; aging.current.amount += amount;
    } else if (days <= 60) {
      aging.d31_60.count += 1; aging.d31_60.amount += amount;
    } else if (days <= 90) {
      aging.d61_90.count += 1; aging.d61_90.amount += amount;
    } else {
      aging.d90plus.count += 1; aging.d90plus.amount += amount;
    }
  }

  return aging;
}

// ---------------------------------------------------------------------------
// Extended data — today's wins, pipeline funnel, stuck items, team, client invoices
// ---------------------------------------------------------------------------

interface TodayWin {
  label: string;
  sub?: string;
}

interface StuckProposal {
  proposalNumber: string;
  clientName: string;
  daysSince: number;
}

interface StuckNegotiation {
  clientName: string;
  daysSince: number;
}

interface TeamMember {
  name: string;
  count: number;
}

interface PendingClientInvoice {
  number: string;
  clientName: string;
  amount: number;
  dueDate: string | null;
  isOverdue: boolean;
  daysOverdue?: number;
}

interface ExtendedData {
  todayWins: TodayWin[];
  pipeline: {
    newLeads: number;
    contacted: number;
    tour: number;
    proposalSent: number;
    negotiating: number;
  };
  stuckProposals: StuckProposal[];
  stuckNegotiations: StuckNegotiation[];
  teamActivity: TeamMember[];
  pendingClientInvoices: PendingClientInvoice[];
  pendingClientTotal: number;
  activeProposals: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchExtended(supabase: any, date: string): Promise<ExtendedData> {
  const dayStart = `${date}T00:00:00`;
  const dayEnd = `${date}T23:59:59`;
  const fiveDaysAgo = new Date(new Date(date).getTime() - 5 * 86400000).toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(new Date(date).getTime() - 7 * 86400000).toISOString().slice(0, 10);

  const [
    wonsToday,
    activatedToday,
    pipelineNew,
    pipelineContacted,
    pipelineTour,
    pipelineProposal,
    pipelineNeg,
    stuckPropRaw,
    stuckNegRaw,
    teamRaw,
    pendingInvRaw,
    activeProposalsCount,
  ] = await Promise.all([
    // Leads won today
    supabase
      .from("leads")
      .select("first_name, last_name, company")
      .gte("converted_at", dayStart)
      .lte("converted_at", dayEnd),
    // Contracts activated today
    supabase
      .from("contracts")
      .select("contract_number, title, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
      .gte("activated_at", dayStart)
      .lte("activated_at", dayEnd),
    // Pipeline funnel counts
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("status", "new"),
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("status", "contacted"),
    supabase.from("leads").select("id", { count: "exact", head: true }).in("status", ["tour_scheduled", "tour_completed"]),
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("status", "proposal_sent"),
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("status", "negotiating"),
    // Stuck proposals — sent more than 5 days ago, still open
    supabase
      .from("proposals")
      .select("proposal_number, lead:leads!proposals_lead_id_fkey(first_name, last_name, company), sent_at")
      .in("status", ["sent", "viewed"])
      .lt("sent_at", `${fiveDaysAgo}T23:59:59`)
      .order("sent_at", { ascending: true })
      .limit(6),
    // Stuck negotiations — lead not updated in 7+ days
    supabase
      .from("leads")
      .select("first_name, last_name, company, updated_at")
      .eq("status", "negotiating")
      .lt("updated_at", `${sevenDaysAgo}T23:59:59`)
      .order("updated_at", { ascending: true })
      .limit(6),
    // Team activity today — activities grouped by user
    supabase
      .from("activities")
      .select("created_by, user:users!activities_created_by_fkey(full_name)")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd),
    // Pending client invoices (proforma) that are sent or overdue
    supabase
      .from("proforma_invoices")
      .select("invoice_number, total_amount, due_date, status, lead:leads!proforma_invoices_lead_id_fkey(first_name, last_name, company)")
      .in("status", ["sent", "overdue"])
      .order("due_date", { ascending: true })
      .limit(10),
    // Active proposals count
    supabase
      .from("proposals")
      .select("id", { count: "exact", head: true })
      .in("status", ["sent", "viewed", "accepted"]),
  ]);

  // Build today's wins
  const todayWins: TodayWin[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const lead of (wonsToday.data || []) as any[]) {
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company || "Lead";
    todayWins.push({ label: `${name} — Lead Converted`, sub: lead.company || undefined });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of (activatedToday.data || []) as any[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = c.lead as any;
    const clientName = lead ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company : "";
    todayWins.push({
      label: `${c.contract_number} — Contract Activated`,
      sub: clientName || c.title || undefined,
    });
  }

  // Stuck proposals
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stuckProposals: StuckProposal[] = (stuckPropRaw.data || []).map((p: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = p.lead as any;
    const clientName = lead
      ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company || "Unknown"
      : "Unknown";
    const sentDate = new Date(p.sent_at);
    const daysSince = Math.floor((new Date(date).getTime() - sentDate.getTime()) / 86400000);
    return { proposalNumber: p.proposal_number, clientName, daysSince };
  });

  // Stuck negotiations
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stuckNegotiations: StuckNegotiation[] = (stuckNegRaw.data || []).map((l: any) => {
    const clientName = [l.first_name, l.last_name].filter(Boolean).join(" ") || l.company || "Unknown";
    const updatedDate = new Date(l.updated_at);
    const daysSince = Math.floor((new Date(date).getTime() - updatedDate.getTime()) / 86400000);
    return { clientName, daysSince };
  });

  // Team activity — aggregate by user
  const teamMap: Record<string, number> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of (teamRaw.data || []) as any[]) {
    const name = row.user?.full_name || "Unknown";
    teamMap[name] = (teamMap[name] || 0) + 1;
  }
  const teamActivity: TeamMember[] = Object.entries(teamMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Pending client invoices
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pendingClientInvoices: PendingClientInvoice[] = (pendingInvRaw.data || []).map((inv: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead = inv.lead as any;
    const clientName = lead
      ? [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.company || "Unknown"
      : "Unknown";
    const isOverdue = inv.due_date ? inv.due_date < date : false;
    const daysOverdue = isOverdue && inv.due_date
      ? Math.floor((new Date(date).getTime() - new Date(inv.due_date).getTime()) / 86400000)
      : undefined;
    return {
      number: inv.invoice_number,
      clientName,
      amount: Number(inv.total_amount || 0),
      dueDate: inv.due_date,
      isOverdue,
      daysOverdue,
    };
  });

  const pendingClientTotal = pendingClientInvoices.reduce((s, i) => s + i.amount, 0);

  return {
    todayWins,
    pipeline: {
      newLeads: pipelineNew.count || 0,
      contacted: pipelineContacted.count || 0,
      tour: pipelineTour.count || 0,
      proposalSent: pipelineProposal.count || 0,
      negotiating: pipelineNeg.count || 0,
    },
    stuckProposals,
    stuckNegotiations,
    teamActivity,
    pendingClientInvoices,
    pendingClientTotal,
    activeProposals: activeProposalsCount.count || 0,
  };
}

// ---------------------------------------------------------------------------
// Storyboard — today's storyline, synthesised from the audit trail
// ---------------------------------------------------------------------------

interface StoryboardEvent {
  icon: string;
  time: string;
  label: string;
  detail?: string;
}

interface AuditRow {
  entity_type: string;
  entity_id: string;
  action: string;
  changes: Record<string, { old: unknown; new: unknown }> | null;
  created_at: string;
}

const ENTITY_ICON: Record<string, string> = {
  lead: "📥",
  proposal: "📄",
  contract: "✅",
  contract_payment: "₹",
  billing_payment: "₹",
  booking_payment: "₹",
  billing_statement: "🧮",
  proforma_invoice: "🧾",
  vendor_bill: "🧾",
  purchase_order: "📦",
  purchase_request: "📦",
  support_ticket: "🎫",
  facility_issue: "🔧",
  task: "✔️",
  petty_cash_entry: "💵",
  booking: "🛋️",
};

// Entity types whose daily movement matters most to management — weighted
// higher so a contract or payment event beats a routine record edit.
const ENTITY_WEIGHT: Record<string, number> = {
  contract: 3, billing_statement: 3, contract_payment: 3, billing_payment: 3,
  booking_payment: 3, vendor_bill: 3, proposal: 3, proforma_invoice: 3, purchase_order: 3,
  facility_issue: 3,
  lead: 2, task: 2, support_ticket: 2, purchase_request: 2, petty_cash_entry: 2,
};

function entityDisplayName(entityType: string): string {
  return entityType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Largest numeric value under an amount-like key in the changes diff — used both to rank and to display ₹ figures. */
function largestAmountInChanges(changes: AuditRow["changes"]): number {
  if (!changes) return 0;
  let max = 0;
  for (const [key, val] of Object.entries(changes)) {
    if (!/amount|fee|total/i.test(key)) continue;
    const n = Number((val as { new: unknown })?.new);
    if (!isNaN(n) && n > max) max = n;
  }
  return max;
}

/**
 * Picks the day's 5 most narratable audit_trail events — weighted toward new
 * records, status transitions, and large ₹ amounts — collapsing an entity
 * touched more than once today to its latest event so the timeline doesn't
 * repeat the same record.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchStoryboardHighlights(supabase: any, date: string): Promise<StoryboardEvent[]> {
  const dayStart = `${date}T00:00:00`;
  const dayEnd = `${date}T23:59:59`;

  const { data: rows } = await supabase
    .from("audit_trail")
    .select("entity_type, entity_id, action, changes, created_at")
    .gte("created_at", dayStart)
    .lte("created_at", dayEnd)
    .order("created_at", { ascending: true })
    .limit(500);

  if (!rows || rows.length === 0) return [];

  const latestByEntity = new Map<string, AuditRow>();
  for (const row of rows as AuditRow[]) {
    latestByEntity.set(`${row.entity_type}:${row.entity_id}`, row);
  }

  const scored = Array.from(latestByEntity.values()).map((row) => {
    const amount = largestAmountInChanges(row.changes);
    const score =
      (ENTITY_WEIGHT[row.entity_type] || 1) +
      (row.action === "create" ? 3 : 0) +
      (amount > 0 ? Math.min(5, Math.floor(amount / 50000)) + 2 : 0);
    return { row, score, amount };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored
    .slice(0, 5)
    .sort((a, b) => new Date(a.row.created_at).getTime() - new Date(b.row.created_at).getTime())
    .map(({ row, amount }) => {
      const summary = summarizeAuditEvent(row);
      const time = new Date(row.created_at).toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit",
      });
      return {
        icon: ENTITY_ICON[row.entity_type] || "📌",
        time,
        label: `${entityDisplayName(row.entity_type)} ${summary.label.toLowerCase()}`,
        detail: amount > 0 ? rupees(amount) : summary.detail,
      };
    });
}

/**
 * One-sentence executive synthesis — the 2-3 highest-magnitude facts of the
 * day (money, contracts won) plus, inline, the single most urgent open item.
 * Deterministic template, no external calls. Full detail for every flag
 * still lives in "Needs Attention" further down — this just leads with it.
 */
function buildStoryHeadline(
  todayIST: string,
  today: Metrics,
  extended: ExtendedData,
  attention: AttentionItems,
  revenueToday: number
): string {
  const parts: string[] = [
    revenueToday > 0 ? `${rupees(revenueToday)} collected` : "a quiet day on collections",
  ];

  if (today.newContracts > 0) {
    parts.push(`${today.newContracts} contract${today.newContracts > 1 ? "s" : ""} activated`);
  } else if (today.leadsWon > 0) {
    parts.push(`${today.leadsWon} lead${today.leadsWon > 1 ? "s" : ""} won`);
  }

  const headline = parts.join(", ");

  const overdueBills = attention.unpaidBills.filter((b) => b.due_date && b.due_date <= todayIST);
  const overdueInvoices = extended.pendingClientInvoices.filter((i) => i.isOverdue);

  let urgent: string | null = null;
  if (overdueBills.length > 0) {
    urgent = `${overdueBills.length} vendor bill${overdueBills.length > 1 ? "s" : ""} (${rupees(overdueBills.reduce((s, b) => s + (b.total_amount - b.amount_paid), 0))}) overdue`;
  } else if (overdueInvoices.length > 0) {
    urgent = `${overdueInvoices.length} client invoice${overdueInvoices.length > 1 ? "s" : ""} overdue`;
  } else if (attention.expiringContracts > 0) {
    urgent = `${attention.expiringContracts} contract${attention.expiringContracts > 1 ? "s" : ""} expiring within 30 days`;
  } else if (extended.stuckProposals.length > 0) {
    urgent = `${extended.stuckProposals.length} proposal${extended.stuckProposals.length > 1 ? "s" : ""} stuck with no response`;
  }

  return `${headline}${urgent ? ` — but ${urgent}` : ""}.`;
}

function storyboardNode(ev: StoryboardEvent): string {
  return `
    <td style="text-align:center;padding:0 4px;">
      <div style="width:30px;height:30px;line-height:30px;border-radius:50%;background:#eef4f3;color:#015E65;font-size:13px;margin:0 auto 6px;">${ev.icon}</div>
      <p style="margin:0;font-size:9.5px;font-weight:600;color:#999;">${ev.time}</p>
      <p style="margin:2px 0 0;font-size:11px;font-weight:600;color:#333;line-height:1.3;">${ev.label}</p>
      ${ev.detail ? `<p style="margin:2px 0 0;font-size:10px;color:#015E65;font-weight:600;">${ev.detail}</p>` : ""}
    </td>`;
}

function buildStoryboardHtml(highlights: StoryboardEvent[], headline: string): string {
  const timelineHtml = highlights.length > 0 ? `
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
      <tr>${highlights.map(storyboardNode).join("")}</tr>
    </table>` : "";

  return `
    <div style="background:#f7fbfa;border:1px solid #d1fae5;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
      <p style="margin:0 0 12px;font-size:11px;font-weight:700;color:#015E65;text-transform:uppercase;letter-spacing:0.5px;">Today's Storyline</p>
      ${timelineHtml}
      <p style="margin:0;font-size:15px;line-height:1.5;color:#222;font-weight:500;">${headline}</p>
    </div>`;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  if (n >= 100000) return `${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString("en-IN");
}

function rupees(n: number): string {
  return `₹${fmt(n)}`;
}

function trend(today: number, compare: number): string {
  if (compare === 0 && today === 0) return "";
  if (compare === 0) return ' <span style="color:#00AE6C;">▲</span>';
  if (today > compare) return ' <span style="color:#00AE6C;">▲</span>';
  if (today < compare) return ' <span style="color:#e53e3e;">▼</span>';
  return "";
}

function metricRow(
  label: string,
  todayVal: string,
  wtdVal: string,
  lwVal: string,
  lyVal: string,
  todayNum: number,
  lwNum: number
): string {
  return `
    <tr>
      <td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;color:#333;font-size:12px;">${label}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#015E65;font-size:12px;text-align:right;">${todayVal}${trend(todayNum, lwNum)}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;font-size:12px;color:#015E65;text-align:right;opacity:0.75;">${wtdVal}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;color:#999;font-size:12px;text-align:right;">${lwVal}</td>
      <td style="padding:7px 10px;border-bottom:1px solid #e5e7eb;color:#bbb;font-size:11px;text-align:right;">${lyVal}</td>
    </tr>`;
}

function tableHeader(): string {
  return `
    <tr style="background:#f7f8fa;">
      <td style="padding:7px 10px;font-weight:600;color:#666;font-size:10px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Metric</td>
      <td style="padding:7px 10px;font-weight:600;color:#666;font-size:10px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Today</td>
      <td style="padding:7px 10px;font-weight:600;color:#666;font-size:10px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">This Week</td>
      <td style="padding:7px 10px;font-weight:600;color:#666;font-size:10px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Last Week</td>
      <td style="padding:7px 10px;font-weight:600;color:#666;font-size:10px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Last Year</td>
    </tr>`;
}

function sectionHeader(title: string): string {
  return `<h2 style="color:#015E65;font-size:15px;margin:0 0 12px;border-bottom:2px solid #015E65;padding-bottom:6px;">${title}</h2>`;
}

// Compact KPI tile used in the top summary row
function kpiTile(label: string, value: string, sub?: string, accent?: boolean): string {
  return `
    <td style="padding:14px 16px;text-align:center;border-right:1px solid #d1fae5;background:${accent ? "#e6f7f0" : "#f0faf5"};">
      <p style="margin:0;color:#666;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">${label}</p>
      <p style="margin:4px 0 0;color:#015E65;font-size:22px;font-weight:700;line-height:1;">${value}</p>
      ${sub ? `<p style="margin:4px 0 0;color:#888;font-size:10px;">${sub}</p>` : ""}
    </td>`;
}

// Pipeline stage pill
function stagePill(label: string, count: number, isWarn: boolean): string {
  const bg = isWarn ? "#fef3c7" : "#f0faf5";
  const color = isWarn ? "#92400e" : "#015E65";
  const border = isWarn ? "#fcd34d" : "#d1fae5";
  return `
    <td style="text-align:center;padding:0 4px;">
      <div style="background:${bg};border:1px solid ${border};border-radius:8px;padding:8px 10px;min-width:60px;">
        <p style="margin:0;font-size:18px;font-weight:700;color:${color};">${count}</p>
        <p style="margin:2px 0 0;font-size:10px;color:${color};opacity:0.8;">${label}</p>
      </div>
    </td>`;
}

// Aging bucket cell for the receivables panel
function agingCell(
  label: string,
  sub: string,
  bucket: AgingBucket,
  bgColor: string,
  textColor: string,
  borderColor: string,
  isLast = false
): string {
  return `
    <td style="text-align:center;padding:14px 12px;background:${bgColor};border-right:${isLast ? "none" : `1px solid ${borderColor}`};">
      <p style="margin:0;font-size:10px;font-weight:700;color:${textColor};text-transform:uppercase;letter-spacing:0.5px;">${label}</p>
      <p style="margin:2px 0 0;font-size:10px;color:${textColor};opacity:0.7;">${sub}</p>
      <p style="margin:8px 0 2px;font-size:20px;font-weight:700;color:${textColor};line-height:1;">${bucket.amount > 0 ? rupees(bucket.amount) : "—"}</p>
      <p style="margin:0;font-size:11px;color:${textColor};opacity:0.8;">${bucket.count} ${bucket.count === 1 ? "invoice" : "invoices"}</p>
    </td>`;
}

function buildReceivablesAgingHtml(aging: ReceivablesAging): string {
  // Nothing to show if no finalized statements and no pending drafts
  if (aging.count === 0 && aging.pendingFinalization.count === 0) return "";

  const hasOverdue = aging.d61_90.count > 0 || aging.d90plus.count > 0;
  const headerBg = hasOverdue ? "#fff5f5" : "#f0fdf4";
  const headerBorder = hasOverdue ? "#feb2b2" : "#bbf7d0";
  const headerAccent = hasOverdue ? "#c53030" : "#065f46";

  // Pending finalization banner — shown above aging when there are drafts awaiting action
  const pendingHtml = aging.pendingFinalization.count > 0
    ? `<div style="background:#fefce8;border-bottom:1px solid #fef08a;padding:8px 16px;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:12px;color:#713f12;">
          📋 <strong>${aging.pendingFinalization.count} statement${aging.pendingFinalization.count === 1 ? "" : "s"} pending finalization</strong>
          — not yet sent to clients, will be due at month-end
        </span>
        <span style="font-size:13px;font-weight:700;color:#713f12;">${rupees(aging.pendingFinalization.amount)}</span>
      </div>`
    : "";

  const viewLink = `<a href="https://twv-crm.vercel.app/billing" style="font-size:11px;color:#015E65;text-decoration:none;font-weight:600;">View Open Receivables →</a>`;

  // If no finalized statements at all, just show the pending banner with no aging table
  if (aging.count === 0) {
    return `
      <div style="border:1px solid #fef08a;border-radius:8px;overflow:hidden;margin-bottom:24px;">
        <div style="background:#fefce8;padding:12px 16px;border-bottom:1px solid #fef08a;display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:12px;font-weight:700;color:#713f12;text-transform:uppercase;letter-spacing:0.5px;">Receivables</span>
          ${viewLink}
        </div>
        ${pendingHtml}
      </div>`;
  }

  return `
    <div style="border:1px solid ${headerBorder};border-radius:8px;overflow:hidden;margin-bottom:24px;">
      <!-- Header row -->
      <div style="background:${headerBg};padding:12px 16px;border-bottom:1px solid ${headerBorder};display:flex;justify-content:space-between;align-items:center;">
        <div>
          <span style="font-size:12px;font-weight:700;color:${headerAccent};text-transform:uppercase;letter-spacing:0.5px;">Receivables Aging</span>
          <span style="font-size:11px;color:#888;margin-left:8px;">(finalized invoices only)</span>
        </div>
        <div style="text-align:right;">
          <span style="font-size:22px;font-weight:700;color:${hasOverdue ? "#c53030" : "#015E65"};">${rupees(aging.total)}</span>
          <span style="font-size:11px;color:#888;margin-left:6px;">${aging.count} outstanding</span>
        </div>
      </div>
      <!-- Pending finalization callout (if any) -->
      ${pendingHtml}
      <!-- Aging buckets -->
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          ${agingCell("Current", "0 – 30 days", aging.current, "#f0fdf4", "#065f46", "#bbf7d0")}
          ${agingCell("Aging", "31 – 60 days", aging.d31_60, "#fffbeb", "#92400e", "#fcd34d")}
          ${agingCell("Late", "61 – 90 days", aging.d61_90, "#fff7ed", "#c2410c", "#fed7aa")}
          ${agingCell("Critical", "90+ days", aging.d90plus, aging.d90plus.count > 0 ? "#fff5f5" : "#fafafa", aging.d90plus.count > 0 ? "#c53030" : "#aaa", aging.d90plus.count > 0 ? "#feb2b2" : "#e5e7eb", true)}
        </tr>
      </table>
      <!-- Footer link -->
      <div style="background:#f9fafb;padding:10px 16px;border-top:1px solid ${headerBorder};text-align:right;">
        ${viewLink}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Main HTML builder
// ---------------------------------------------------------------------------

/** Format a short date like "Mon 21 Apr" for the WTD label */
function shortDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short", day: "numeric", month: "short",
  });
}

/** Render one WTD metric cell (week total + today's contribution) */
function wtdCell(label: string, weekVal: string, todayVal: string, todayIsZero?: boolean): string {
  return `
    <td style="text-align:center;padding:8px 6px;border-right:1px solid #e5e7eb;">
      <p style="margin:0;font-size:17px;font-weight:700;color:#015E65;">${weekVal}</p>
      <p style="margin:2px 0 0;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.3px;">${label}</p>
      <p style="margin:3px 0 0;font-size:10px;font-weight:600;color:${todayIsZero ? "#bbb" : "#00AE6C"};">${todayIsZero ? "—" : `+${todayVal} today`}</p>
    </td>`;
}

function buildDigestHtml(
  dateLabel: string,
  todayIST: string,
  weekStart: string,
  yesterday: Metrics,
  yesterdayIST: string,
  yesterdayLocations: LocationRow[],
  today: Metrics,
  lw: Metrics,
  ly: Metrics,
  wtd: Metrics,
  locations: LocationRow[],
  attention: AttentionItems,
  portfolio: Portfolio,
  extended: ExtendedData,
  receivables: ReceivablesAging,
  storyboard: StoryboardEvent[]
): string {
  const revenueToday = today.collections + today.bookingRevenue;
  const revenueYesterday = yesterday.collections + yesterday.bookingRevenue;

  // ── Today's Storyline ───────────────────────────────────────────────────
  const storyHeadline = buildStoryHeadline(todayIST, today, extended, attention, revenueToday);
  const storyboardHtml = buildStoryboardHtml(storyboard, storyHeadline);

  // ── Yesterday's Collections ───────────────────────────────────────────────
  const yesterdayLabel = new Date(yesterdayIST + "T00:00:00").toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short",
  });
  const activeYesterdayLocations = yesterdayLocations.filter(l => l.collections > 0 || l.bookings > 0);
  const yesterdayHtml = `
    <div style="background:#f0faf5;border:1px solid #d1fae5;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
      <p style="margin:0 0 10px;font-size:11px;font-weight:700;color:#015E65;text-transform:uppercase;letter-spacing:0.4px;">
        Yesterday's Collections &nbsp;·&nbsp; ${yesterdayLabel}
      </p>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:0 12px 0 0;">
            <p style="margin:0;font-size:22px;font-weight:700;color:#015E65;">${revenueYesterday > 0 ? rupees(revenueYesterday) : "—"}</p>
            <p style="margin:2px 0 0;font-size:10px;color:#888;">Total (contract ${rupees(yesterday.collections)} + bookings ${rupees(yesterday.bookingRevenue)})</p>
          </td>
          ${activeYesterdayLocations.length > 0 ? `
          <td style="padding-left:16px;border-left:1px solid #d1fae5;">
            ${activeYesterdayLocations.map(l => `
              <span style="display:inline-block;margin:2px 8px 2px 0;font-size:12px;color:#015E65;">
                <strong>${l.name}</strong> ${rupees(l.collections)}
              </span>`).join("")}
          </td>` : ""}
        </tr>
      </table>
    </div>`;

  // ── KPI row ──────────────────────────────────────────────────────────────
  const stuckCount = extended.stuckProposals.length + extended.stuckNegotiations.length;
  const kpiHtml = `
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;border:1px solid #d1fae5;border-radius:8px;overflow:hidden;">
      <tr>
        ${kpiTile("Revenue In", revenueToday > 0 ? rupees(revenueToday) : "—", "collections + bookings")}
        ${kpiTile("New Leads", `${today.newLeads}`, today.newLeads > 0 ? `${today.leadsWon} won · ${today.leadsLost} lost` : "none today")}
        ${kpiTile("Active Proposals", `${extended.activeProposals}`, stuckCount > 0 ? `⚠ ${stuckCount} stuck` : "pipeline healthy", stuckCount > 0)}
        ${kpiTile("Active Contracts", `${portfolio.activeContracts}`, `MRR ${rupees(portfolio.totalMRR)}`)}
      </tr>
    </table>`;

  // ── Week to Date strip ────────────────────────────────────────────────────
  const wtdRevenue = wtd.collections + wtd.bookingRevenue;
  const isMonday = weekStart === todayIST; // first day of week — WTD = today, no strip needed
  const wtdHtml = !isMonday ? `
    <div style="background:#f7f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin-bottom:24px;">
      <p style="margin:0 0 10px;font-size:11px;font-weight:700;color:#015E65;text-transform:uppercase;letter-spacing:0.4px;">
        Week to Date &nbsp;·&nbsp; ${shortDate(weekStart)} – ${shortDate(todayIST)}
      </p>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          ${wtdCell("Revenue", wtdRevenue > 0 ? rupees(wtdRevenue) : "—", rupees(revenueToday), revenueToday === 0)}
          ${wtdCell("New Leads", `${wtd.newLeads}`, `${today.newLeads}`, today.newLeads === 0)}
          ${wtdCell("Won", `${wtd.leadsWon}`, `${today.leadsWon}`, today.leadsWon === 0)}
          ${wtdCell("Activities", `${wtd.activities}`, `${today.activities}`, today.activities === 0)}
          ${wtdCell("Bookings", `${wtd.newBookings}`, `${today.newBookings}`, today.newBookings === 0)}
          <td style="text-align:center;padding:8px 6px;">
            <p style="margin:0;font-size:17px;font-weight:700;color:#015E65;">${wtd.invoiceAmount > 0 ? rupees(wtd.invoiceAmount) : "—"}</p>
            <p style="margin:2px 0 0;font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.3px;">Invoiced</p>
            <p style="margin:3px 0 0;font-size:10px;font-weight:600;color:${today.invoiceCount === 0 ? "#bbb" : "#00AE6C"};">${today.invoiceCount === 0 ? "—" : `+${today.invoiceCount} today`}</p>
          </td>
        </tr>
      </table>
    </div>` : "";

  // ── Today's Wins (only shown if there are wins) ───────────────────────────
  const winsHtml = extended.todayWins.length > 0 ? `
    <div style="background:#ecfdf5;border:1px solid #6ee7b7;border-left:4px solid #10b981;border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:24px;">
      <p style="margin:0 0 10px;font-weight:700;color:#065f46;font-size:14px;">🏆 Today's Wins</p>
      ${extended.todayWins.map(w => `
        <div style="margin-bottom:6px;">
          <span style="color:#065f46;font-size:13px;font-weight:600;">✓ ${w.label}</span>
          ${w.sub ? `<span style="color:#6ee7b7;font-size:11px;"> · ${w.sub}</span>` : ""}
        </div>`).join("")}
    </div>` : "";

  // ── Pipeline at a glance ─────────────────────────────────────────────────
  const p = extended.pipeline;
  const totalInPipeline = p.newLeads + p.contacted + p.tour + p.proposalSent + p.negotiating;
  const pipelineHtml = `
    ${sectionHeader("Pipeline at a Glance")}
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
      <tr>
        ${stagePill("New", p.newLeads, false)}
        <td style="text-align:center;color:#ccc;font-size:16px;padding:0;">→</td>
        ${stagePill("Contacted", p.contacted, false)}
        <td style="text-align:center;color:#ccc;font-size:16px;padding:0;">→</td>
        ${stagePill("Tour", p.tour, false)}
        <td style="text-align:center;color:#ccc;font-size:16px;padding:0;">→</td>
        ${stagePill("Proposal Out", p.proposalSent, p.proposalSent > 0 && extended.stuckProposals.length > 0)}
        <td style="text-align:center;color:#ccc;font-size:16px;padding:0;">→</td>
        ${stagePill("Negotiating", p.negotiating, p.negotiating > 0 && extended.stuckNegotiations.length > 0)}
      </tr>
    </table>
    <p style="color:#888;font-size:11px;margin:0 0 24px;text-align:right;">${totalInPipeline} active leads in pipeline</p>`;

  // ── Stuck Pipeline ─────────────────────────────────────────────────────
  const hasStuck = extended.stuckProposals.length > 0 || extended.stuckNegotiations.length > 0;
  const stuckHtml = hasStuck ? `
    <div style="background:#fffbeb;border:1px solid #fcd34d;border-left:4px solid #f59e0b;border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:24px;">
      <p style="margin:0 0 10px;font-weight:700;color:#92400e;font-size:14px;">⚠ Stuck Pipeline — Needs Follow-Up</p>
      ${extended.stuckProposals.length > 0 ? `
        <p style="margin:0 0 6px;color:#78350f;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">Proposals with no response (${extended.stuckProposals.length > 5 ? "top 5 of " + extended.stuckProposals.length : extended.stuckProposals.length})</p>
        ${extended.stuckProposals.slice(0, 5).map(sp => `
          <p style="margin:3px 0;color:#78350f;font-size:13px;">• <strong>${sp.proposalNumber}</strong> · ${sp.clientName} · <span style="color:#b45309;">${sp.daysSince}d since sent</span></p>`).join("")}
      ` : ""}
      ${extended.stuckNegotiations.length > 0 ? `
        <p style="margin:${extended.stuckProposals.length > 0 ? "10px" : "0"} 0 6px;color:#78350f;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">Stalled Negotiations (${extended.stuckNegotiations.length > 5 ? "top 5 of " + extended.stuckNegotiations.length : extended.stuckNegotiations.length})</p>
        ${extended.stuckNegotiations.slice(0, 5).map(sn => `
          <p style="margin:3px 0;color:#78350f;font-size:13px;">• <strong>${sn.clientName}</strong> · <span style="color:#b45309;">${sn.daysSince}d since last activity</span></p>`).join("")}
      ` : ""}
    </div>` : "";

  // ── Needs Attention (3-tier) ─────────────────────────────────────────────
  const overdueItems: string[] = [];
  const thisWeekItems: string[] = [];

  // Act Today
  if (attention.overdueTasks > 0)
    overdueItems.push(`${attention.overdueTasks} overdue task${attention.overdueTasks > 1 ? "s" : ""}${attention.overdueTasksUrgent > 0 ? ` (${attention.overdueTasksUrgent} urgent/high)` : ""}`);

  const overdueInvoices = extended.pendingClientInvoices.filter(i => i.isOverdue);
  if (overdueInvoices.length > 0)
    overdueItems.push(`${overdueInvoices.length} client invoice${overdueInvoices.length > 1 ? "s" : ""} overdue (${rupees(overdueInvoices.reduce((s, i) => s + i.amount, 0))})`);

  const overdueBills = attention.unpaidBills.filter(b => b.due_date && b.due_date <= todayIST);
  if (overdueBills.length > 0)
    overdueItems.push(`${overdueBills.length} vendor bill${overdueBills.length > 1 ? "s" : ""} overdue (${rupees(overdueBills.reduce((s, b) => s + (b.total_amount - b.amount_paid), 0))})`);

  if (attention.workOrdersSlaAtRisk > 0)
    overdueItems.push(`${attention.workOrdersSlaAtRisk} work order${attention.workOrdersSlaAtRisk > 1 ? "s" : ""} past SLA target, still open`);

  // This Week
  if (attention.expiringContracts > 0)
    thisWeekItems.push(`${attention.expiringContracts} contract${attention.expiringContracts > 1 ? "s" : ""} expiring in 30 days`);
  if (attention.pendingFollowups > 0)
    thisWeekItems.push(`${attention.pendingFollowups} follow-up${attention.pendingFollowups > 1 ? "s" : ""} pending`);
  if (attention.workOrdersOpenCritical > 0)
    thisWeekItems.push(`${attention.workOrdersOpenCritical} critical work order${attention.workOrdersOpenCritical > 1 ? "s" : ""} open`);

  const upcomingBills = attention.unpaidBills.filter(b => b.due_date && b.due_date > todayIST);
  if (upcomingBills.length > 0)
    thisWeekItems.push(`${upcomingBills.length} upcoming vendor bill${upcomingBills.length > 1 ? "s" : ""} (${rupees(upcomingBills.reduce((s, b) => s + (b.total_amount - b.amount_paid), 0))})`);

  const attentionHtml = (overdueItems.length > 0 || thisWeekItems.length > 0) ? `
    ${sectionHeader("Needs Attention")}
    ${overdueItems.length > 0 ? `
      <div style="background:#fff5f5;border-left:3px solid #e53e3e;padding:12px 16px;margin-bottom:10px;border-radius:0 6px 6px 0;">
        <p style="margin:0 0 6px;font-weight:700;color:#c53030;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;">🔴 Act Today</p>
        ${overdueItems.map(i => `<p style="margin:3px 0;color:#742a2a;font-size:13px;">• ${i}</p>`).join("")}
      </div>` : ""}
    ${thisWeekItems.length > 0 ? `
      <div style="background:#fffbeb;border-left:3px solid #f59e0b;padding:12px 16px;margin-bottom:24px;border-radius:0 6px 6px 0;">
        <p style="margin:0 0 6px;font-weight:700;color:#b45309;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;">🟡 This Week</p>
        ${thisWeekItems.map(i => `<p style="margin:3px 0;color:#78350f;font-size:13px;">• ${i}</p>`).join("")}
      </div>` : `<div style="margin-bottom:24px;"></div>`}
  ` : "";

  // ── Team Activity ──────────────────────────────────────────────────────
  const teamHtml = extended.teamActivity.length > 0 ? `
    <div style="background:#f7f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;margin-bottom:24px;">
      <p style="margin:0 0 8px;font-weight:600;color:#015E65;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;">Team Activity Today</p>
      <p style="margin:0;color:#333;font-size:13px;">
        ${extended.teamActivity.map((m, i) =>
          `<span style="color:#015E65;font-weight:600;">${m.name}</span> <span style="color:#888;">${m.count} ${m.count === 1 ? "activity" : "activities"}</span>${i < extended.teamActivity.length - 1 ? ' <span style="color:#d1d5db;margin:0 6px;">·</span>' : ""}`
        ).join("")}
      </p>
    </div>` : "";

  // ── Financial Summary ───────────────────────────────────────────────────
  const financialRows = [
    metricRow("Collections", rupees(today.collections), rupees(wtd.collections), rupees(lw.collections), rupees(ly.collections), today.collections, lw.collections),
    metricRow("Booking Revenue", rupees(today.bookingRevenue), rupees(wtd.bookingRevenue), rupees(lw.bookingRevenue), rupees(ly.bookingRevenue), today.bookingRevenue, lw.bookingRevenue),
    metricRow("Invoices Raised", `${today.invoiceCount} (${rupees(today.invoiceAmount)})`, `${wtd.invoiceCount} (${rupees(wtd.invoiceAmount)})`, `${lw.invoiceCount}`, `${ly.invoiceCount}`, today.invoiceCount, lw.invoiceCount),
    metricRow("Petty Cash Spend", rupees(today.pettyCashSpend), rupees(wtd.pettyCashSpend), rupees(lw.pettyCashSpend), rupees(ly.pettyCashSpend), today.pettyCashSpend, lw.pettyCashSpend),
    metricRow("POs Raised", `${today.posRaised} (${rupees(today.poAmount)})`, `${wtd.posRaised} (${rupees(wtd.poAmount)})`, `${lw.posRaised}`, `${ly.posRaised}`, today.posRaised, lw.posRaised),
  ].join("");

  // ── Operations ──────────────────────────────────────────────────────────
  const opsRows = [
    metricRow("New Leads", `${today.newLeads}`, `${wtd.newLeads}`, `${lw.newLeads}`, `${ly.newLeads}`, today.newLeads, lw.newLeads),
    metricRow("Won / Lost", `${today.leadsWon} / ${today.leadsLost}`, `${wtd.leadsWon} / ${wtd.leadsLost}`, `${lw.leadsWon} / ${lw.leadsLost}`, `${ly.leadsWon} / ${ly.leadsLost}`, today.leadsWon, lw.leadsWon),
    metricRow("Activities Logged", `${today.activities}`, `${wtd.activities}`, `${lw.activities}`, `${ly.activities}`, today.activities, lw.activities),
    metricRow("Tasks Completed", `${today.tasksCompleted}`, `${wtd.tasksCompleted}`, `${lw.tasksCompleted}`, `${ly.tasksCompleted}`, today.tasksCompleted, lw.tasksCompleted),
    metricRow("Bookings", `${today.newBookings}`, `${wtd.newBookings}`, `${lw.newBookings}`, `${ly.newBookings}`, today.newBookings, lw.newBookings),
    metricRow("New Contracts", `${today.newContracts}`, `${wtd.newContracts}`, `${lw.newContracts}`, `${ly.newContracts}`, today.newContracts, lw.newContracts),
    metricRow("Support Tickets", `${today.supportTickets}`, `${wtd.supportTickets}`, `${lw.supportTickets}`, `${ly.supportTickets}`, today.supportTickets, lw.supportTickets),
    metricRow(
      "Work Orders (opened/closed)",
      `${today.workOrdersOpened}/${today.workOrdersClosed}`,
      `${wtd.workOrdersOpened}/${wtd.workOrdersClosed}`,
      `${lw.workOrdersOpened}/${lw.workOrdersClosed}`,
      `${ly.workOrdersOpened}/${ly.workOrdersClosed}`,
      today.workOrdersOpened, lw.workOrdersOpened
    ),
  ].join("");

  // ── Center-wise ─────────────────────────────────────────────────────────
  const locationRows = locations.map(l => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:13px;">${l.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#015E65;font-size:13px;text-align:right;">${rupees(l.collections)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:13px;text-align:right;">${l.leads}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:13px;text-align:right;">${l.bookings}</td>
    </tr>`).join("");

  // ── Outstanding Client Invoices ─────────────────────────────────────────
  const clientInvHtml = extended.pendingClientInvoices.length > 0 ? `
    ${sectionHeader(`Outstanding Client Invoices (${extended.pendingClientInvoices.length})`)}
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr style="background:#f7f8fa;">
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Client</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Invoice #</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Amount</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Due</td>
      </tr>
      ${extended.pendingClientInvoices.map(inv => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:12px;">${inv.clientName}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:12px;">${inv.number}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;color:${inv.isOverdue ? "#e53e3e" : "#015E65"};font-size:12px;text-align:right;">${rupees(inv.amount)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:12px;color:${inv.isOverdue ? "#e53e3e" : "#333"};">
          ${inv.dueDate ? new Date(inv.dueDate).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }) : "—"}
          ${inv.isOverdue && inv.daysOverdue ? `<span style="font-size:10px;color:#e53e3e;"> (${inv.daysOverdue}d overdue)</span>` : ""}
        </td>
      </tr>`).join("")}
      <tr style="background:#f7f8fa;">
        <td colspan="2" style="padding:8px 12px;font-weight:600;color:#333;font-size:12px;">Total Outstanding</td>
        <td style="padding:8px 12px;font-weight:700;color:#e53e3e;font-size:13px;text-align:right;">${rupees(extended.pendingClientTotal)}</td>
        <td></td>
      </tr>
    </table>` : "";

  // ── Vendor Obligations ──────────────────────────────────────────────────
  const billsTableHtml = attention.unpaidBills.length > 0 ? `
    ${sectionHeader(`Vendor Obligations (${attention.unpaidBills.length})`)}
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr style="background:#f7f8fa;">
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Vendor</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Invoice #</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Amount</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Paid</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Balance</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Due</td>
      </tr>
      ${attention.unpaidBills.map(b => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:12px;">${b.vendor_name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:12px;">${b.invoice_number}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:12px;text-align:right;">${rupees(b.total_amount)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:12px;text-align:right;">${rupees(b.amount_paid)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#e53e3e;font-size:12px;text-align:right;">${rupees(b.total_amount - b.amount_paid)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:${b.due_date && b.due_date <= todayIST ? "#e53e3e" : "#333"};font-size:12px;">${b.due_date ? new Date(b.due_date).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }) : "—"}</td>
      </tr>`).join("")}
      <tr style="background:#f7f8fa;">
        <td colspan="4" style="padding:8px 12px;font-weight:600;color:#333;font-size:12px;">Total Outstanding</td>
        <td style="padding:8px 12px;font-weight:700;color:#e53e3e;font-size:13px;text-align:right;">${rupees(attention.unpaidBillsTotal)}</td>
        <td></td>
      </tr>
    </table>` : "";

  // ── Assemble ────────────────────────────────────────────────────────────
  return `
<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:660px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#ffffff;">

  <!-- Header -->
  <div style="background:#015E65;padding:24px 32px;">
    <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:700;">The WorkVilla</h1>
    <p style="color:#00AE6C;margin:6px 0 0;font-size:13px;font-weight:500;">Daily Business Digest</p>
    <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px;">${dateLabel}</p>
  </div>

  <div style="padding:28px 32px;">

    <!-- Today's Storyline -->
    ${storyboardHtml}

    <!-- Yesterday's Collections -->
    ${yesterdayHtml}

    <!-- KPI Snapshot -->
    ${kpiHtml}

    <!-- Receivables Aging -->
    ${buildReceivablesAgingHtml(receivables)}

    <!-- Week to Date -->
    ${wtdHtml}

    <!-- Today's Wins -->
    ${winsHtml}

    <!-- Pipeline -->
    ${pipelineHtml}

    <!-- Stuck Pipeline -->
    ${stuckHtml}

    <!-- Needs Attention -->
    ${attentionHtml}

    <!-- Team Activity -->
    ${teamHtml}

    <!-- Financial Summary -->
    ${sectionHeader("Financial Summary")}
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      ${tableHeader()}
      ${financialRows}
    </table>

    <!-- Operations -->
    ${sectionHeader("Operations")}
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      ${tableHeader()}
      ${opsRows}
    </table>

    <!-- Center-wise -->
    ${sectionHeader("Center-wise (Today)")}
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr style="background:#f7f8fa;">
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Center</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Collections</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Leads</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Bookings</td>
      </tr>
      ${locationRows}
    </table>

    <!-- Outstanding Client Invoices -->
    ${clientInvHtml}

    <!-- Vendor Obligations -->
    ${billsTableHtml}

  </div>

  <!-- Footer -->
  <div style="background:#015E65;padding:16px 32px;text-align:center;">
    <p style="color:#ffffff;margin:0;font-size:11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
    <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
    <p style="color:#00AE6C;margin:4px 0 0;font-size:10px;">www.theworkvilla.com</p>
  </div>

</div>`;
}
