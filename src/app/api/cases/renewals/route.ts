import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { renewalRate } from "@/lib/vo-renewal";
import { renewalRecipients } from "@/lib/renewal-recipients";
import { partnerRenewalRecord } from "@/lib/vo-renewal-reminders";
import { latestLapseDecision } from "@/lib/vo-lapse-decision";
import {
  RENEWED_WINDOW_DAYS,
  RENEWAL_DESK_WINDOW_DAYS,
  needsAction,
  noticeSchedule,
  renewalBoardTab,
  VO_RENEWAL_GRACE_DAYS_SETTING,
  daysUntil,
  graceLastDay,
  parseGraceDays,
} from "@/lib/vo-renewal-desk";

/**
 * GET /api/cases/renewals — every Virtual Office case the Renewals desk
 * shows, already sorted into its tab. Read-only: nothing here sends a notice,
 * creates a bill or changes a case.
 *
 * ?location_id= narrows to one centre.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const locationId = new URL(request.url).searchParams.get("location_id");

  // Calendar date in IST — the business's day, same as the renewal cron.
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const renewedSince = new Date(Date.parse(today) - RENEWED_WINDOW_DAYS * 86_400_000).toISOString();
  const horizon = new Date(Date.parse(today) + RENEWAL_DESK_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  let query = supabase
    .from("cases")
    .select(
      `id, case_number, status, purpose, client_name, client_company_name, client_email, client_phone,
       aggregator_id, bill_to, end_date, tenure_months, rate, renewal_escalation_percentage,
       renewal_notices_enabled, renewal_grace_ends_at, renewed_at, metadata,
       aggregator:aggregators!cases_aggregator_id_fkey(id, name, billing_method, primary_email, primary_phone),
       location:locations!cases_location_id_fkey(id, name)`
    )
    // Lapsed and Active cases whatever their date (Active is the board's
    // "ends later" tab); renewal-stage cases only inside the window (past end
    // dates included); Renewed only when renewed recently.
    .or(
      `status.in.(lapsed,active),and(status.in.(renewal_due,grace_period),end_date.lte.${horizon}),and(status.eq.renewed,renewed_at.gte.${renewedSince})`,
    )
    .order("end_date", { ascending: true, nullsFirst: false });
  if (locationId) query = query.eq("location_id", locationId);

  const [{ data: cases, error }, settings] = await Promise.all([
    query,
    getCachedSettings(await createAdminClient(), [VO_RENEWAL_GRACE_DAYS_SETTING]),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const graceDays = parseGraceDays(settings[VO_RENEWAL_GRACE_DAYS_SETTING]);

  const ids = (cases ?? []).map((c) => c.id as string);
  if (ids.length === 0) return NextResponse.json({ data: [], today, grace_days: graceDays });

  const [billsRes, remindersRes, draftsRes] = await Promise.all([
    supabase
      .from("billing_statements")
      .select("id, case_id, statement_number, total_amount, payment_status, period_start, period_end, created_at")
      .in("case_id", ids)
      .eq("statement_type", "vo_renewal")
      .is("voided_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("vo_renewal_reminders")
      .select("case_id, reminder_number, sent_at, email_sent, whatsapp_sent")
      .in("case_id", ids)
      .order("sent_at", { ascending: false }),
    supabase
      .from("vo_discontinuation_documents")
      .select("case_id, status")
      .in("case_id", ids),
  ]);

  // Newest first, so the first bill seen per case is its latest.
  type Bill = { id: string; statement_number: string | null; total_amount: number; payment_status: string; period_start: string | null; created_at: string };
  const openBill = new Map<string, Bill>();
  for (const b of billsRes.data ?? []) {
    const caseId = b.case_id as string;
    if (openBill.has(caseId) || b.payment_status === "paid") continue;
    const c = (cases ?? []).find((x) => x.id === caseId);
    // A bill for a term the case has already moved past isn't open any more.
    if (c?.end_date && b.period_start && b.period_start < (c.end_date as string)) continue;
    openBill.set(caseId, b as Bill);
  }

  type LogRow = { reminder_number: number; sent_at: string; email_sent: boolean; whatsapp_sent: boolean };
  const reminderLog = new Map<string, LogRow[]>();
  const reminders = new Map<string, { count: number; last_sent_at: string }>();
  for (const r of remindersRes.data ?? []) {
    const caseId = r.case_id as string;
    const log = reminderLog.get(caseId) ?? [];
    log.push(r as unknown as LogRow);
    reminderLog.set(caseId, log);
    const cur = reminders.get(caseId);
    if (cur) cur.count += 1;
    else reminders.set(caseId, { count: 1, last_sent_at: r.sent_at as string });
  }

  const drafts = new Map<string, number>();
  for (const d of draftsRes.data ?? []) {
    if (d.status !== "draft") continue;
    drafts.set(d.case_id as string, (drafts.get(d.case_id as string) ?? 0) + 1);
  }

  const rows = (cases ?? []).flatMap((c) => {
    const bill = openBill.get(c.id as string) ?? null;
    const term = {
      status: c.status as string,
      end_date: c.end_date as string | null,
      renewal_grace_ends_at: c.renewal_grace_ends_at as string | null,
      renewed_at: c.renewed_at as string | null,
    };
    const tab = renewalBoardTab(term, today, !!bill, graceDays);
    if (!tab) return [];

    const aggregator = Array.isArray(c.aggregator) ? c.aggregator[0] : c.aggregator;
    const location = Array.isArray(c.location) ? c.location[0] : c.location;
    const isPostpaid = !!c.aggregator_id && aggregator?.billing_method === "postpaid";
    const routing = renewalRecipients({
      client_name: c.client_name as string,
      client_company_name: c.client_company_name as string | null,
      client_email: c.client_email as string | null,
      client_phone: c.client_phone as string | null,
      aggregator_id: c.aggregator_id as string | null,
      bill_to: c.bill_to as "aggregator" | "client" | null,
      aggregator: aggregator ?? null,
    });

    const partnerRecord = isPostpaid ? partnerRenewalRecord(c.metadata) : null;
    const lapseDecision = latestLapseDecision(c.metadata)?.decision ?? null;
    const reminderCount = reminders.get(c.id as string)?.count ?? 0;
    const daysLeft = c.end_date ? daysUntil(c.end_date as string, today) : null;

    return [{
      id: c.id,
      case_number: c.case_number,
      client: (c.client_company_name as string | null) || (c.client_name as string),
      purpose: c.purpose,
      status: c.status,
      location: location?.name ?? null,
      location_id: location?.id ?? null,
      tab,
      end_date: c.end_date,
      days_left: daysLeft,
      needs_action: needsAction({
        tab,
        days_left: daysLeft,
        postpaid: isPostpaid,
        partner_confirmed: !!partnerRecord,
        reminder_count: reminderCount,
        lapse_decision: lapseDecision,
      }),
      renewed_at: c.renewed_at ?? null,
      recipients: {
        billing: routing.billing,
        heads_up: routing.headsUp,
      },
      notice_schedule: noticeSchedule({ end_date: c.end_date as string | null }, reminderLog.get(c.id as string) ?? [], today),
      grace_last_day: tab === "grace" ? graceLastDay(term, graceDays) : null,
      payer: {
        kind: routing.billing.kind,
        name: routing.billing.name,
        postpaid: isPostpaid,
        blocked: routing.blocked,
      },
      fee: isPostpaid || c.rate == null ? null : renewalRate({
        rate: Number(c.rate),
        renewal_escalation_percentage: c.renewal_escalation_percentage as number | null,
      }),
      escalation_percentage: c.renewal_escalation_percentage ?? null,
      notices_enabled: c.renewal_notices_enabled ?? null,
      open_bill: bill
        ? {
            id: bill.id,
            statement_number: bill.statement_number,
            total_amount: Number(bill.total_amount),
            payment_status: bill.payment_status,
            created_at: bill.created_at,
          }
        : null,
      partner_confirmation: partnerRecord
        ? { term_start: partnerRecord.term_start, new_rate: partnerRecord.new_rate }
        : null,
      reminders: reminders.get(c.id as string) ?? { count: 0, last_sent_at: null },
      draft_documents: drafts.get(c.id as string) ?? 0,
    }];
  });

  return NextResponse.json({ data: rows, today, grace_days: graceDays });
}
