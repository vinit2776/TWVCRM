/**
 * GET /api/tds/receivable
 *
 * Returns all billing_payments where tds_amount > 0, joined to the
 * statement + contract + lead so the TDS Receivable tab can display
 * client name, invoice number, section, and amount.
 *
 * Optional query params:
 *   fy_year  — FY start year  (e.g. 2024 for FY 2024-25). Defaults to current FY.
 *   quarter  — 1 | 2 | 3 | 4 (null = all quarters in the FY).
 *
 * FY date mapping:
 *   Q1 Apr–Jun (months 4,5,6)  | Q2 Jul–Sep (7,8,9)
 *   Q3 Oct–Dec (10,11,12)      | Q4 Jan–Mar (1,2,3 of fy_year+1)
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const QUARTER_MONTHS: Record<string, number[]> = {
  "1": [4, 5, 6],
  "2": [7, 8, 9],
  "3": [10, 11, 12],
  "4": [1, 2, 3],
};

function currentFyYear(): number {
  const d = new Date();
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}

// A certificate not yet uploaded within 45 days of the payment is flagged
// "overdue" — a tunable placeholder, not a cited compliance deadline. Below
// that it's just "pending" (normal — Form 16A issuance lags the deduction).
const CERTIFICATE_OVERDUE_DAYS = 45;

function certificateStatus(
  hasCertificate: boolean,
  paymentDate: string
): "received" | "pending" | "overdue" {
  if (hasCertificate) return "received";
  const days = Math.floor((Date.now() - Date.parse(paymentDate + "T00:00:00Z")) / 86400000);
  return days >= CERTIFICATE_OVERDUE_DAYS ? "overdue" : "pending";
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const fyYear  = parseInt(searchParams.get("fy_year") || String(currentFyYear()), 10);
  const quarter = searchParams.get("quarter") || null;   // null = full FY

  // Build date range from FY year + optional quarter.
  // Q4 straddles years: months 1–3 belong to fyYear+1.
  let dateFrom: string;
  let dateTo: string;

  if (quarter && QUARTER_MONTHS[quarter]) {
    const months = QUARTER_MONTHS[quarter];
    const calYear = quarter === "4" ? fyYear + 1 : fyYear;
    dateFrom = `${calYear}-${String(months[0]).padStart(2, "0")}-01`;
    const lastMonth = months[months.length - 1];
    const lastDay = new Date(calYear, lastMonth, 0).getDate();
    dateTo   = `${calYear}-${String(lastMonth).padStart(2, "0")}-${lastDay}`;
  } else {
    // Full FY: 1 Apr fyYear → 31 Mar fyYear+1
    dateFrom = `${fyYear}-04-01`;
    dateTo   = `${fyYear + 1}-03-31`;
  }

  const { data, error } = await supabase
    .from("billing_payments")
    .select(`
      id,
      payment_date,
      amount,
      tds_amount,
      tds_section,
      payment_mode,
      payment_reference,
      tds_certificate_path,
      certificate_reminder_count,
      last_certificate_reminder_sent_at,
      billing_statement:billing_statements!billing_payments_billing_statement_id_fkey(
        id,
        statement_number,
        gst_invoice_number,
        period_start,
        period_end,
        total_amount,
        contract:contracts!billing_statements_contract_id_fkey(
          id,
          contract_number,
          lead:leads!contracts_lead_id_fkey(
            id,
            first_name,
            last_name,
            company,
            pan_number,
            email,
            billing_emails
          )
        )
      )
    `)
    .gt("tds_amount", 0)
    .gte("payment_date", dateFrom)
    .lte("payment_date", dateTo)
    .order("payment_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Flatten and shape the response
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []).map((p: any) => {
    const stmt    = p.billing_statement;
    const contract = stmt?.contract;
    const lead     = contract?.lead;
    const clientName = lead?.company
      || `${lead?.first_name || ""} ${lead?.last_name || ""}`.trim()
      || "—";
    const clientEmails: string[] = Array.from(new Set([lead?.email, ...(lead?.billing_emails || [])].filter(Boolean)));

    return {
      id:               p.id,
      payment_date:     p.payment_date,
      amount:           Number(p.amount),
      tds_amount:       Number(p.tds_amount),
      tds_section:      p.tds_section ?? null,
      payment_mode:     p.payment_mode,
      payment_reference: p.payment_reference ?? null,
      tds_certificate_path: p.tds_certificate_path ?? null,
      certificate_status: certificateStatus(!!p.tds_certificate_path, p.payment_date),
      certificate_reminder_count: p.certificate_reminder_count ?? 0,
      last_certificate_reminder_sent_at: p.last_certificate_reminder_sent_at ?? null,
      client_emails:    clientEmails,
      statement_number: stmt?.statement_number ?? null,
      invoice_number:   stmt?.gst_invoice_number ?? null,
      period_start:     stmt?.period_start ?? null,
      period_end:       stmt?.period_end ?? null,
      statement_total:  stmt ? Number(stmt.total_amount) : null,
      contract_number:  contract?.contract_number ?? null,
      client_name:      clientName,
      pan_number:       lead?.pan_number ?? null,
    };
  });

  // Section-level summary for the header cards
  const sectionTotals: Record<string, number> = {};
  let grandTotal = 0;
  let pendingCount = 0;
  let overdueCount = 0;
  for (const r of rows) {
    const sec = r.tds_section ?? "Unknown";
    sectionTotals[sec] = (sectionTotals[sec] || 0) + r.tds_amount;
    grandTotal += r.tds_amount;
    if (r.certificate_status === "pending") pendingCount++;
    if (r.certificate_status === "overdue") overdueCount++;
  }

  return NextResponse.json({
    rows,
    summary: {
      grand_total: grandTotal,
      by_section: sectionTotals,
      count: rows.length,
      certificates_pending: pendingCount,
      certificates_overdue: overdueCount,
    },
    period: { fy_year: fyYear, quarter, date_from: dateFrom, date_to: dateTo },
  });
}
