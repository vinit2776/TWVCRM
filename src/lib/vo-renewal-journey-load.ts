import type { SupabaseClient } from "@supabase/supabase-js";
import { renewalRecipients } from "@/lib/renewal-recipients";
import { partnerRenewalRecord } from "@/lib/vo-renewal-reminders";
import { latestLapseDecision } from "@/lib/vo-lapse-decision";
import { graceLastDay } from "@/lib/vo-renewal-desk";
import { statementCoversNextTerm } from "@/lib/vo-renewal-term";
import {
  computeRenewalJourney,
  type RenewalJourney,
  type RenewalJourneyInput,
} from "@/lib/vo-renewal-journey";

/** The case columns the journey is worked out from. */
export const JOURNEY_CASE_SELECT = `id, status, purpose, client_name, client_company_name, client_email, client_phone,
  aggregator_id, bill_to, end_date, renewal_grace_ends_at, metadata,
  aggregator:aggregators!cases_aggregator_id_fkey(id, name, billing_method, primary_email, primary_phone)`;

type Row = Record<string, unknown>;

/**
 * The journey for each of the given cases, keyed by case id. Read-only: it
 * only reads bills, notices, reported payments and discontinuation documents.
 * `cases` are rows selected with JOURNEY_CASE_SELECT.
 */
export async function loadRenewalJourneys(
  supabase: SupabaseClient,
  cases: Row[],
  ctx: { today: string; graceDays: number },
): Promise<Map<string, RenewalJourney>> {
  const out = new Map<string, RenewalJourney>();
  if (cases.length === 0) return out;
  const ids = cases.map((c) => c.id as string);
  const renewedIds = cases.filter((c) => c.status === "renewed").map((c) => c.id as string);

  const [billsRes, remindersRes, docsRes, successorsRes] = await Promise.all([
    supabase
      .from("billing_statements")
      .select("id, case_id, statement_number, total_amount, payment_status, period_start, period_end, created_at")
      .in("case_id", ids)
      .eq("statement_type", "vo_renewal")
      .is("voided_at", null)
      .order("created_at", { ascending: false }),
    supabase.from("vo_renewal_reminders").select("case_id").in("case_id", ids),
    supabase.from("vo_discontinuation_documents").select("case_id, status").in("case_id", ids),
    renewedIds.length
      ? supabase
          .from("cases")
          .select("id, case_number, metadata")
          .in("metadata->>renewed_from_case_id", renewedIds)
      : Promise.resolve({ data: [] as Row[] }),
  ]);

  // Newest first, so the first unpaid bill seen per case is its latest. A bill
  // for a term the case has already moved past is not open any more.
  const caseById = new Map(cases.map((c) => [c.id as string, c]));
  const openBill = new Map<string, Row>();
  for (const b of (billsRes.data ?? []) as Row[]) {
    const caseId = b.case_id as string;
    if (openBill.has(caseId) || b.payment_status === "paid") continue;
    const c = caseById.get(caseId);
    if (!statementCoversNextTerm(b.period_start as string | null, (c?.end_date as string | null) ?? null)) continue;
    openBill.set(caseId, b);
  }

  const reportRes = openBill.size
    ? await supabase
        .from("query_payment_reports")
        .select("claimed_statement_id, amount, paid_on, created_by")
        .in("claimed_statement_id", Array.from(openBill.values()).map((b) => b.id as string))
        .eq("status", "reported")
        .order("created_at", { ascending: false })
    : { data: [] as Row[] };
  const reporterIds = Array.from(
    new Set(((reportRes.data ?? []) as Row[]).map((r) => r.created_by as string).filter(Boolean)),
  );
  const names = new Map<string, string>();
  if (reporterIds.length) {
    const { data: users } = await supabase.from("users").select("id, full_name").in("id", reporterIds);
    for (const u of (users ?? []) as Row[]) names.set(u.id as string, u.full_name as string);
  }
  const reportByBill = new Map<string, Row>();
  for (const r of (reportRes.data ?? []) as Row[]) {
    if (!reportByBill.has(r.claimed_statement_id as string)) reportByBill.set(r.claimed_statement_id as string, r);
  }

  const notices = new Map<string, number>();
  for (const r of (remindersRes.data ?? []) as Row[]) {
    notices.set(r.case_id as string, (notices.get(r.case_id as string) ?? 0) + 1);
  }

  const docs = new Map<string, { drafts: number; sent: boolean }>();
  for (const d of (docsRes.data ?? []) as Row[]) {
    const cur = docs.get(d.case_id as string) ?? { drafts: 0, sent: false };
    if (d.status === "draft") cur.drafts += 1;
    else cur.sent = true;
    docs.set(d.case_id as string, cur);
  }

  const successors = new Map<string, { id: string; caseNumber: string | null }>();
  for (const s of (successorsRes.data ?? []) as Row[]) {
    const from = (s.metadata as Record<string, unknown> | null)?.renewed_from_case_id;
    if (typeof from === "string") successors.set(from, { id: s.id as string, caseNumber: (s.case_number as string | null) ?? null });
  }

  for (const c of cases) {
    const id = c.id as string;
    const aggregator = Array.isArray(c.aggregator) ? c.aggregator[0] : c.aggregator;
    const postpaid = !!c.aggregator_id && (aggregator as Row | undefined)?.billing_method === "postpaid";
    const routing = renewalRecipients({
      client_name: c.client_name as string,
      client_company_name: c.client_company_name as string | null,
      client_email: c.client_email as string | null,
      client_phone: c.client_phone as string | null,
      aggregator_id: c.aggregator_id as string | null,
      bill_to: c.bill_to as "aggregator" | "client" | null,
      aggregator: (aggregator as Row | undefined) ?? null,
    });
    const bill = openBill.get(id) ?? null;
    const report = bill ? reportByBill.get(bill.id as string) ?? null : null;
    const conf = postpaid ? partnerRenewalRecord(c.metadata) : null;
    const d = docs.get(id);

    const input: RenewalJourneyInput = {
      today: ctx.today,
      caseStatus: c.status as string,
      endDate: (c.end_date as string | null) ?? null,
      graceLastDay: graceLastDay(
        { end_date: (c.end_date as string | null) ?? null, renewal_grace_ends_at: c.renewal_grace_ends_at as string | null },
        ctx.graceDays,
      ),
      purpose: (c.purpose as string | null) ?? null,
      payer: {
        postpaid,
        blocked: routing.blocked ? "choose who is billed (the partner or the client)" : null,
        hasEmail: !!routing.billing.email,
        hasPhone: !!routing.billing.phone,
      },
      openBill: bill
        ? {
            statementNumber: (bill.statement_number as string | null) ?? null,
            totalAmount: Number(bill.total_amount),
            periodStart: (bill.period_start as string | null) ?? null,
            periodEnd: (bill.period_end as string | null) ?? null,
          }
        : null,
      notices: { count: notices.get(id) ?? 0 },
      openReport: report
        ? {
            amount: Number(report.amount),
            paidOn: report.paid_on as string,
            reportedBy: names.get(report.created_by as string) ?? null,
          }
        : null,
      partnerConfirmation: conf ? { termStart: conf.term_start, newRate: conf.new_rate } : null,
      lapse: {
        latestDecision: latestLapseDecision(c.metadata)?.decision ?? null,
        draftDocuments: d?.drafts ?? 0,
        documentsSent: d?.sent ?? false,
      },
      successor: successors.get(id) ?? null,
    };
    out.set(id, computeRenewalJourney(input));
  }
  return out;
}
