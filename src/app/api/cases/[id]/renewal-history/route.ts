import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/cases/[id]/renewal-history — what has happened on this case's
 * renewals: every notice sent, every renewal bill, and every payment against
 * those bills with where it came from (link or recorded), its reference, who
 * reported it and who recorded it. Read-only.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Used inside a PostgREST or() filter below.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid case id" }, { status: 400 });

  // Paying a renewal moves its bill onto the next term's case. The renewed
  // case keeps a pointer to it, so its history still shows what renewed it.
  const { data: caseRow } = await supabase
    .from("cases")
    .select("renewal_billing_statement_id")
    .eq("id", id)
    .maybeSingle();
  const movedBillId = caseRow?.renewal_billing_statement_id as string | null | undefined;

  const [remindersRes, billsRes] = await Promise.all([
    supabase
      .from("vo_renewal_reminders")
      .select("id, reminder_number, sent_at, email_sent, whatsapp_sent, is_grace_notice, billing_statement_id")
      .eq("case_id", id)
      .order("sent_at", { ascending: false }),
    supabase
      .from("billing_statements")
      .select("id, statement_number, period_start, period_end, total_amount, payment_status, created_at, voided_at")
      .or(movedBillId ? `case_id.eq.${id},id.eq.${movedBillId}` : `case_id.eq.${id}`)
      .eq("statement_type", "vo_renewal")
      .order("created_at", { ascending: false }),
  ]);
  if (billsRes.error) return NextResponse.json({ error: billsRes.error.message }, { status: 500 });

  const bills = billsRes.data ?? [];
  const billIds = bills.map((b) => b.id as string);

  let payments: Record<string, unknown>[] = [];
  let reports: Record<string, unknown>[] = [];
  if (billIds.length > 0) {
    const [paymentsRes, reportsRes] = await Promise.all([
      supabase
        .from("billing_payments")
        .select(
          "id, billing_statement_id, amount, payment_date, payment_mode, payment_reference, razorpay_payment_id, notes, created_at, recorder:users!billing_payments_recorded_by_fkey(id, full_name)",
        )
        .in("billing_statement_id", billIds)
        .order("created_at", { ascending: false }),
      supabase
        .from("query_payment_reports")
        .select("id, billing_payment_id, claimed_statement_id, amount, paid_on, payment_mode, payment_reference, payer_name, status, created_by, created_at")
        .in("claimed_statement_id", billIds),
    ]);
    payments = paymentsRes.data ?? [];
    reports = reportsRes.data ?? [];
  }

  // Reporter names: query_payment_reports.created_by is a users.id.
  const reporterIds = Array.from(new Set(reports.map((r) => r.created_by as string).filter(Boolean)));
  const names = new Map<string, string>();
  if (reporterIds.length > 0) {
    const { data: users } = await supabase.from("users").select("id, full_name").in("id", reporterIds);
    for (const u of users ?? []) names.set(u.id as string, u.full_name as string);
  }

  const reportByPayment = new Map<string, Record<string, unknown>>();
  for (const r of reports) {
    if (r.billing_payment_id) reportByPayment.set(r.billing_payment_id as string, r);
  }

  const billNumber = new Map(bills.map((b) => [b.id as string, b.statement_number as string | null]));

  return NextResponse.json({
    data: {
      reminders: remindersRes.data ?? [],
      bills: bills.map((b) => ({
        ...b,
        total_amount: Number(b.total_amount),
      })),
      payments: payments.map((p) => {
        const recorder = (Array.isArray(p.recorder) ? p.recorder[0] : p.recorder) as { full_name?: string } | null;
        const report = reportByPayment.get(p.id as string);
        return {
          id: p.id,
          statement_number: billNumber.get(p.billing_statement_id as string) ?? null,
          amount: Number(p.amount),
          payment_date: p.payment_date,
          payment_mode: p.payment_mode,
          // A Razorpay link payment has no human recorder; anything else was
          // recorded by accounts or admin.
          source: p.razorpay_payment_id ? "razorpay_link" : "recorded",
          reference: (p.razorpay_payment_id as string | null) || (p.payment_reference as string | null),
          recorded_by: recorder?.full_name ?? null,
          reported_by: report ? names.get(report.created_by as string) ?? null : null,
          payer_name: report ? (report.payer_name as string | null) : null,
          recorded_at: p.created_at,
        };
      }),
      // Claims not yet matched to a bank credit, so staff can see one is pending.
      open_reports: reports
        .filter((r) => r.status === "reported")
        .map((r) => ({
          id: r.id,
          statement_number: billNumber.get(r.claimed_statement_id as string) ?? null,
          amount: Number(r.amount),
          paid_on: r.paid_on,
          payment_mode: r.payment_mode,
          reference: r.payment_reference,
          reported_by: names.get(r.created_by as string) ?? null,
          reported_at: r.created_at,
        })),
    },
  });
}
