import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";

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

  const supabase = await createAdminClient();

  // Fetch recipients
  const { data: setting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "digest_recipients")
    .single();

  let recipients: string[] = [];
  try {
    recipients = JSON.parse(setting?.value || "[]");
  } catch {
    recipients = [];
  }

  if (recipients.length === 0) {
    return NextResponse.json({ error: "No digest recipients configured" }, { status: 400 });
  }

  // Aggregate data for 3 date windows
  const [today, lw, ly] = await Promise.all([
    fetchMetrics(supabase, todayIST),
    fetchMetrics(supabase, lastWeek),
    fetchMetrics(supabase, lastYear),
  ]);

  // Today-only: location breakdown, attention items, portfolio snapshot
  const [locations, attention, portfolio] = await Promise.all([
    fetchLocationBreakdown(supabase, todayIST),
    fetchAttentionItems(supabase, todayIST),
    fetchPortfolio(supabase),
  ]);

  // Build and send email
  const dateLabel = new Date(todayIST + "T00:00:00").toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const html = buildDigestHtml(dateLabel, today, lw, ly, locations, attention, portfolio);

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

  return NextResponse.json({
    date: todayIST,
    recipients: recipients.length,
    sent,
    metrics: { today, lastWeek: lw, lastYear: ly },
    locations,
    attention,
    portfolio,
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchMetrics(supabase: any, date: string): Promise<Metrics> {
  const dayStart = `${date}T00:00:00`;
  const dayEnd = `${date}T23:59:59`;

  const [
    collections,
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
  ] = await Promise.all([
    // Collections (contract payments)
    supabase
      .from("contract_payments")
      .select("amount")
      .eq("status", "verified")
      .eq("payment_date", date),
    // Booking revenue
    supabase
      .from("booking_payments")
      .select("amount")
      .eq("status", "verified")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd),
    // Invoices
    supabase
      .from("proforma_invoices")
      .select("total_amount")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd),
    // Petty cash spend
    supabase
      .from("petty_cash_entries")
      .select("amount")
      .eq("status", "approved")
      .eq("date", date),
    // Purchase orders
    supabase
      .from("purchase_orders")
      .select("total_ordered_amount")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd),
    // New leads
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd),
    // Won leads
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .gte("converted_at", dayStart)
      .lte("converted_at", dayEnd),
    // Lost leads
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .gte("lost_at", dayStart)
      .lte("lost_at", dayEnd),
    // Activities
    supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd),
    // Tasks completed
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .gte("completed_at", dayStart)
      .lte("completed_at", dayEnd),
    // New bookings
    supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("booking_date", date)
      .in("status", ["confirmed", "checked_in", "checked_out", "completed"]),
    // New contracts
    supabase
      .from("contracts")
      .select("id", { count: "exact", head: true })
      .eq("status", "active")
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd),
    // Support tickets
    supabase
      .from("support_tickets")
      .select("id", { count: "exact", head: true })
      .gte("created_at", dayStart)
      .lte("created_at", dayEnd),
  ]);

  const sum = (rows: { amount?: number; total_amount?: number; total_ordered_amount?: number }[] | null, field: string) =>
    (rows || []).reduce((s, r) => s + Number((r as Record<string, unknown>)[field] || 0), 0);

  return {
    collections: sum(collections.data, "amount"),
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

  // Get all active locations
  const { data: locs } = await supabase
    .from("locations")
    .select("id, name")
    .eq("is_active", true)
    .order("name");

  if (!locs || locs.length === 0) return [];

  const results: LocationRow[] = [];

  // Fetch all verified payments for the date with contract's location
  const { data: allPayments } = await supabase
    .from("contract_payments")
    .select("amount, contract:contracts!contract_payments_contract_id_fkey(location_id)")
    .eq("status", "verified")
    .eq("payment_date", date);

  for (const loc of locs) {
    const locPayments = (allPayments || []).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p: any) => p.contract?.location_id === loc.id
    );
    const colTotal = locPayments.reduce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: number, r: any) => s + Number(r.amount || 0),
      0
    );

    const [leads, bookings] = await Promise.all([
      supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .gte("created_at", dayStart)
        .lte("created_at", dayEnd)
        .eq("location_id", loc.id),
      supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("booking_date", date)
        .in("status", ["confirmed", "checked_in", "checked_out", "completed"])
        .eq("location_id", loc.id),
    ]);

    results.push({
      name: loc.name,
      collections: colTotal,
      leads: leads.count || 0,
      bookings: bookings.count || 0,
    });
  }

  return results;
}

interface AttentionItems {
  overdueTasks: number;
  unpaidBills: number;
  unpaidBillsAmount: number;
  expiringContracts: number;
  pendingFollowups: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAttentionItems(supabase: any, date: string): Promise<AttentionItems> {
  const thirtyDaysOut = new Date(new Date(date).getTime() + 30 * 86400000)
    .toISOString()
    .slice(0, 10);

  const [overdue, bills, expiring, followups] = await Promise.all([
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .lt("due_date", date)
      .neq("status", "done"),
    supabase
      .from("vendor_bills")
      .select("total_amount")
      .neq("payment_status", "paid"),
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
  ]);

  const billRows = bills.data || [];
  return {
    overdueTasks: overdue.count || 0,
    unpaidBills: billRows.length,
    unpaidBillsAmount: billRows.reduce(
      (s: number, r: { total_amount: number }) => s + Number(r.total_amount || 0),
      0
    ),
    expiringContracts: expiring.count || 0,
    pendingFollowups: followups.count || 0,
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
// HTML email builder
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
  lwVal: string,
  lyVal: string,
  todayNum: number,
  lwNum: number
): string {
  return `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:13px;">${label}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#015E65;font-size:13px;text-align:right;">${todayVal}${trend(todayNum, lwNum)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#666;font-size:13px;text-align:right;">${lwVal}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#666;font-size:13px;text-align:right;">${lyVal}</td>
    </tr>`;
}

function tableHeader(): string {
  return `
    <tr style="background:#f7f8fa;">
      <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Metric</td>
      <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Today</td>
      <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Last Week</td>
      <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Last Year</td>
    </tr>`;
}

function buildDigestHtml(
  dateLabel: string,
  today: Metrics,
  lw: Metrics,
  ly: Metrics,
  locations: LocationRow[],
  attention: AttentionItems,
  portfolio: Portfolio
): string {
  const financialRows = [
    metricRow("Collections", rupees(today.collections), rupees(lw.collections), rupees(ly.collections), today.collections, lw.collections),
    metricRow("Booking Revenue", rupees(today.bookingRevenue), rupees(lw.bookingRevenue), rupees(ly.bookingRevenue), today.bookingRevenue, lw.bookingRevenue),
    metricRow("Invoices Raised", `${today.invoiceCount} (${rupees(today.invoiceAmount)})`, `${lw.invoiceCount}`, `${ly.invoiceCount}`, today.invoiceCount, lw.invoiceCount),
    metricRow("Petty Cash Spend", rupees(today.pettyCashSpend), rupees(lw.pettyCashSpend), rupees(ly.pettyCashSpend), today.pettyCashSpend, lw.pettyCashSpend),
    metricRow("POs Raised", `${today.posRaised} (${rupees(today.poAmount)})`, `${lw.posRaised}`, `${ly.posRaised}`, today.posRaised, lw.posRaised),
  ].join("");

  const opsRows = [
    metricRow("New Leads", `${today.newLeads}`, `${lw.newLeads}`, `${ly.newLeads}`, today.newLeads, lw.newLeads),
    metricRow("Won / Lost", `${today.leadsWon} / ${today.leadsLost}`, `${lw.leadsWon} / ${lw.leadsLost}`, `${ly.leadsWon} / ${ly.leadsLost}`, today.leadsWon, lw.leadsWon),
    metricRow("Activities Logged", `${today.activities}`, `${lw.activities}`, `${ly.activities}`, today.activities, lw.activities),
    metricRow("Tasks Completed", `${today.tasksCompleted}`, `${lw.tasksCompleted}`, `${ly.tasksCompleted}`, today.tasksCompleted, lw.tasksCompleted),
    metricRow("Bookings", `${today.newBookings}`, `${lw.newBookings}`, `${ly.newBookings}`, today.newBookings, lw.newBookings),
    metricRow("New Contracts", `${today.newContracts}`, `${lw.newContracts}`, `${ly.newContracts}`, today.newContracts, lw.newContracts),
    metricRow("Support Tickets", `${today.supportTickets}`, `${lw.supportTickets}`, `${ly.supportTickets}`, today.supportTickets, lw.supportTickets),
  ].join("");

  const locationRows = locations
    .map(
      (l) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:13px;">${l.name}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#015E65;font-size:13px;text-align:right;">${rupees(l.collections)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:13px;text-align:right;">${l.leads}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#333;font-size:13px;text-align:right;">${l.bookings}</td>
    </tr>`
    )
    .join("");

  const attentionList: string[] = [];
  if (attention.overdueTasks > 0) attentionList.push(`${attention.overdueTasks} overdue task${attention.overdueTasks > 1 ? "s" : ""}`);
  if (attention.unpaidBills > 0) attentionList.push(`${attention.unpaidBills} unpaid vendor bill${attention.unpaidBills > 1 ? "s" : ""} (${rupees(attention.unpaidBillsAmount)})`);
  if (attention.expiringContracts > 0) attentionList.push(`${attention.expiringContracts} contract${attention.expiringContracts > 1 ? "s" : ""} expiring in 30 days`);
  if (attention.pendingFollowups > 0) attentionList.push(`${attention.pendingFollowups} pending follow-up${attention.pendingFollowups > 1 ? "s" : ""}`);

  const attentionHtml =
    attentionList.length > 0
      ? `
    <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px 20px;border-radius:0 8px 8px 0;margin:24px 0;">
      <p style="margin:0 0 8px;font-weight:700;color:#92400e;font-size:14px;">Attention Items</p>
      ${attentionList.map((item) => `<p style="margin:4px 0;color:#78350f;font-size:13px;">• ${item}</p>`).join("")}
    </div>`
      : "";

  return `
<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#ffffff;">
  <!-- Header -->
  <div style="background:#015E65;padding:24px 32px;">
    <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:700;">The WorkVilla</h1>
    <p style="color:#00AE6C;margin:6px 0 0;font-size:13px;font-weight:500;">Daily Business Digest</p>
    <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px;">${dateLabel}</p>
  </div>

  <div style="padding:28px 32px;">

    <!-- Portfolio Snapshot -->
    <div style="display:flex;gap:0;margin-bottom:24px;">
      <div style="flex:1;background:#f0faf5;padding:16px;border-radius:8px 0 0 8px;border:1px solid #d1fae5;text-align:center;">
        <p style="margin:0;color:#666;font-size:11px;text-transform:uppercase;">Active Contracts</p>
        <p style="margin:4px 0 0;color:#015E65;font-size:24px;font-weight:700;">${portfolio.activeContracts}</p>
      </div>
      <div style="flex:1;background:#f0faf5;padding:16px;border-radius:0 8px 8px 0;border:1px solid #d1fae5;border-left:0;text-align:center;">
        <p style="margin:0;color:#666;font-size:11px;text-transform:uppercase;">Monthly Recurring Revenue</p>
        <p style="margin:4px 0 0;color:#015E65;font-size:24px;font-weight:700;">${rupees(portfolio.totalMRR)}</p>
      </div>
    </div>

    <!-- Financial Highlights -->
    <h2 style="color:#015E65;font-size:15px;margin:0 0 12px;border-bottom:2px solid #015E65;padding-bottom:6px;">Financial Highlights</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      ${tableHeader()}
      ${financialRows}
    </table>

    <!-- Operations -->
    <h2 style="color:#015E65;font-size:15px;margin:0 0 12px;border-bottom:2px solid #015E65;padding-bottom:6px;">Operations</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      ${tableHeader()}
      ${opsRows}
    </table>

    <!-- Center-wise -->
    <h2 style="color:#015E65;font-size:15px;margin:0 0 12px;border-bottom:2px solid #015E65;padding-bottom:6px;">Center-wise (Today)</h2>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr style="background:#f7f8fa;">
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;">Center</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Collections</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Leads</td>
        <td style="padding:8px 12px;font-weight:600;color:#666;font-size:11px;text-transform:uppercase;border-bottom:2px solid #e5e7eb;text-align:right;">Bookings</td>
      </tr>
      ${locationRows}
    </table>

    ${attentionHtml}

  </div>

  <!-- Footer -->
  <div style="background:#015E65;padding:16px 32px;text-align:center;">
    <p style="color:#ffffff;margin:0;font-size:11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
    <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
    <p style="color:#00AE6C;margin:4px 0 0;font-size:10px;">www.theworkvilla.com</p>
  </div>
</div>`;
}

export const maxDuration = 60;
