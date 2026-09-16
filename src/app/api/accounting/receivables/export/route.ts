import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { paymentCredit, balanceDue } from "@/lib/settlement";
import { fetchOtherReceivables } from "../route";
import { RECEIVABLE_KIND_LABELS } from "@/lib/receivables";

/**
 * GET /api/accounting/receivables/export
 *
 * Downloads the current AR list as a CSV — one row per outstanding statement,
 * plus a summary footer with grand totals per aging bucket. Used by the
 * "Export CSV" button on /accounting/receivables for management reporting.
 *
 * Aging buckets are computed from `due_date` (today in IST):
 *   Current     = due_date in future
 *   1-30 days   = 0..30 days past due
 *   31-60 days  = 31..60
 *   61-90 days  = 61..90
 *   90+ days    = > 90
 */
export async function GET(_req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: statements, error } = await supabase
    .from("billing_statements")
    .select(`
      id, statement_number, statement_type, period_start, period_end, due_date,
      total_amount, payment_status, last_reminder_sent_at, reminder_count,
      contract:contracts!billing_statements_contract_id_fkey(
        contract_number,
        lead:leads!contracts_lead_id_fkey(first_name, last_name, company, email, phone, mobile)
      )
    `)
    .in("status", ["finalized", "exported"])
    .in("payment_status", ["unpaid", "partially_paid"])
    .is("voided_at", null)
    .order("due_date", { ascending: true, nullsFirst: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (statements || []).map((s) => s.id as string);
  // Paid-to-date includes TDS — same settlement definition as the payment route.
  let paidByStmt = new Map<string, number>();
  if (ids.length > 0) {
    const { data: pays } = await supabase
      .from("billing_payments").select("billing_statement_id, amount, tds_amount").in("billing_statement_id", ids);
    paidByStmt = (pays || []).reduce((m, p: { billing_statement_id: string; amount: number; tds_amount: number | null }) => {
      m.set(p.billing_statement_id, (m.get(p.billing_statement_id) || 0) + paymentCredit(p));
      return m;
    }, new Map<string, number>());
  }

  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const todayIst = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
  const todayMs = Date.parse(todayIst + "T00:00:00Z");

  type Bucket = "current" | "1-30" | "31-60" | "61-90" | "90+";
  const buckets: Record<Bucket, number> = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  function bucketOf(days: number | null): Bucket {
    if (days === null || days < 0) return "current";
    if (days <= 30) return "1-30";
    if (days <= 60) return "31-60";
    if (days <= 90) return "61-90";
    return "90+";
  }

  const rows: string[][] = [
    ["Contract", "Customer", "Email", "Phone", "Statement #", "Type", "Period Start", "Period End", "Due Date", "Days Overdue", "Aging Bucket", "Total", "Paid", "Balance", "Reminders Sent", "Last Reminder"],
  ];

  let grandTotal = 0, grandPaid = 0, grandBalance = 0;

  for (const s of statements || []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contract: any = s.contract;
    const lead = contract?.lead;
    const customerName = lead?.company || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim() || "—";
    const paid = paidByStmt.get(s.id as string) || 0;
    const balance = balanceDue(s.total_amount as number, paid);
    let daysOverdue: number | null = null;
    if (s.due_date) {
      const dueMs = Date.parse((s.due_date as string) + "T00:00:00Z");
      daysOverdue = Math.floor((todayMs - dueMs) / 86400000);
    }
    const bucket = bucketOf(daysOverdue);
    buckets[bucket] += balance;
    grandTotal += Number(s.total_amount);
    grandPaid += paid;
    grandBalance += balance;

    rows.push([
      contract?.contract_number || "—",
      customerName,
      lead?.email || "",
      lead?.mobile || lead?.phone || "",
      s.statement_number,
      s.statement_type || "",
      s.period_start as string,
      s.period_end as string,
      (s.due_date as string) || "",
      daysOverdue !== null ? String(daysOverdue) : "",
      bucket,
      String(Math.round(Number(s.total_amount))),
      String(Math.round(paid)),
      String(Math.round(balance)),
      String(s.reminder_count || 0),
      s.last_reminder_sent_at ? String(s.last_reminder_sent_at).slice(0, 10) : "",
    ]);
  }

  // Summary footer
  rows.push([]);
  rows.push(["AGING SUMMARY"]);
  rows.push(["Bucket", "Outstanding (₹)"]);
  rows.push(["Current (not yet due)", String(Math.round(buckets.current))]);
  rows.push(["1-30 days overdue", String(Math.round(buckets["1-30"]))]);
  rows.push(["31-60 days overdue", String(Math.round(buckets["31-60"]))]);
  rows.push(["61-90 days overdue", String(Math.round(buckets["61-90"]))]);
  rows.push(["90+ days overdue", String(Math.round(buckets["90+"]))]);
  rows.push([]);
  rows.push(["GRAND TOTAL (statements only)", "", "", "", "", "", "", "", "", "", "", String(Math.round(grandTotal)), String(Math.round(grandPaid)), String(Math.round(grandBalance))]);

  // ── Deposits, top-ups and ad-hoc invoices — outside billing_statements,
  // so absent from every row/total above. Appended as their own section
  // rather than merged into the aging buckets (which are due_date-only and
  // statement-shaped) so this export isn't silently undercounting them the
  // way the AR page itself used to.
  const otherReceivables = await fetchOtherReceivables(supabase);
  let otherBalance = 0;
  rows.push([]);
  rows.push(["DEPOSITS & AD-HOC INVOICES"]);
  rows.push(["Kind", "Reference", "Customer", "Due Date", "Days Overdue", "Balance"]);
  for (const r of otherReceivables) {
    otherBalance += r.balance_due;
    rows.push([
      RECEIVABLE_KIND_LABELS[r.kind],
      r.reference,
      r.party_name,
      r.due_date || "",
      r.days_overdue !== null ? String(r.days_overdue) : "",
      String(Math.round(r.balance_due)),
    ]);
  }
  rows.push([]);
  rows.push(["Deposits & ad-hoc invoices subtotal", "", "", "", "", String(Math.round(otherBalance))]);
  rows.push([]);
  rows.push(["GRAND TOTAL (statements + deposits/ad-hoc)", "", "", "", "", "", "", "", "", "", "", String(Math.round(grandBalance + otherBalance))]);
  rows.push([]);
  rows.push([`Report run: ${new Date().toISOString()} (UTC) · ${todayIst} (IST)`]);

  // CSV-escape: quote fields that contain comma, quote, or newline.
  const csv = rows.map((row) => row.map((cell) => {
    const s = String(cell ?? "");
    if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }).join(",")).join("\n");

  // Excel assumes the system codepage without a BOM, which mangles ₹ and any
  // non-ASCII character (e.g. the "—" placeholder) into junk like "â€"".
  return new NextResponse("\ufeff" + csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="receivables-aging-${todayIst}.csv"`,
    },
  });
}
