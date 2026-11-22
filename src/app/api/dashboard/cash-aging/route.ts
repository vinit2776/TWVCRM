import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { getDashboardAuth } from "@/lib/dashboard-auth";
import { paymentCredit, balanceDue } from "@/lib/settlement";

/**
 * GET /api/dashboard/cash-aging
 * Returns receivables (billing_statements unpaid) and payables (vendor_bills unpaid)
 * bucketed by age: current / 0-30 / 31-60 / 60+
 *
 * Access: admin, accounts.
 */
export async function GET() {
  const { user, dbUser } = await getDashboardAuth();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();

  if (!dbUser || !["admin", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const now = new Date();
  const today = now.toISOString().split("T")[0];

  type Bucket = { count: number; total: number };
  const empty = (): Bucket => ({ count: 0, total: 0 });

  function ageBuckets(rows: { ref_date: string; amount: number }[]) {
    const buckets = {
      current: empty(),
      d_0_30: empty(),
      d_31_60: empty(),
      d_60_plus: empty(),
    };
    for (const r of rows) {
      const age = Math.floor(
        (now.getTime() - new Date(r.ref_date).getTime()) / 86_400_000
      );
      let key: keyof typeof buckets;
      if (age < 0) key = "current";
      else if (age <= 30) key = "d_0_30";
      else if (age <= 60) key = "d_31_60";
      else key = "d_60_plus";
      buckets[key].count += 1;
      buckets[key].total += r.amount;
    }
    return buckets;
  }

  const [
    { data: statements },
    { data: bills },
  ] = await Promise.all([
    // Receivables: finalized billing statements not fully paid.
    // Use period_end as reference for aging.
    adminSupabase
      .from("billing_statements")
      .select("id, total_amount, period_end, payment_status, status")
      .eq("status", "finalized")
      .neq("payment_status", "paid"),

    // Payables: vendor bills unpaid / partial. Use due_date if present, fall
    // back to invoice_date. Scoped to approval_status = 'approved' — a
    // pending bill isn't actually payable yet (Acc Payables only records
    // payments against approved bills, and its default list view filters
    // to approved), so counting it here overstates what's owed. Matches
    // the receivables side, which likewise only counts finalized statements.
    adminSupabase
      .from("vendor_bills")
      .select("id, total_amount, amount_paid, due_date, invoice_date, payment_status, approved_at, created_at")
      .eq("approval_status", "approved")
      .in("payment_status", ["unpaid", "partially_paid"]),
  ]);

  // Receivables age on the outstanding balance, not the full invoice total —
  // partial payments (including TDS deductions) reduce what's actually owed.
  // Same settlement definition as the payment route and the AR view.
  const stmtIds = (statements ?? []).map((s) => s.id as string);
  const paidByStmt = new Map<string, number>();
  if (stmtIds.length > 0) {
    const { data: pays } = await adminSupabase
      .from("billing_payments")
      .select("billing_statement_id, amount, tds_amount")
      .in("billing_statement_id", stmtIds);
    for (const p of pays ?? []) {
      paidByStmt.set(p.billing_statement_id, (paidByStmt.get(p.billing_statement_id) || 0) + paymentCredit(p));
    }
  }

  const recvRows = (statements ?? []).map((s) => ({
    ref_date: s.period_end,
    amount: balanceDue(s.total_amount as number, paidByStmt.get(s.id as string) || 0),
  }));
  const payRows = (bills ?? []).map((b) => ({
    ref_date: b.due_date ?? b.invoice_date ?? today,
    amount: Math.max(0, Number(b.total_amount ?? 0) - Number(b.amount_paid ?? 0)),
    // A bill joins the payables queue when it is approved, not when it was
    // raised — approved_at is what "new" should track. Bills still awaiting
    // approval have no approved_at, so they fall back to created_at.
    entered_at: (b.approved_at as string | null) ?? (b.created_at as string | null),
  }));

  const round = (n: number) => Math.round(n * 100) / 100;
  const r = ageBuckets(recvRows);
  const p = ageBuckets(payRows);

  const receivablesTotal = recvRows.reduce((s, x) => s + x.amount, 0);
  const payablesTotal = payRows.reduce((s, x) => s + x.amount, 0);

  // "New" on the accounts dashboard means arrived in the last 24 hours.
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const payNew = payRows.filter((x) => !!x.entered_at && x.entered_at >= dayAgo);

  return NextResponse.json({
    data: {
      receivables: {
        total: round(receivablesTotal),
        count: recvRows.length,
        current: { count: r.current.count, total: round(r.current.total) },
        d_0_30: { count: r.d_0_30.count, total: round(r.d_0_30.total) },
        d_31_60: { count: r.d_31_60.count, total: round(r.d_31_60.total) },
        d_60_plus: { count: r.d_60_plus.count, total: round(r.d_60_plus.total) },
      },
      payables: {
        total: round(payablesTotal),
        count: payRows.length,
        current: { count: p.current.count, total: round(p.current.total) },
        d_0_30: { count: p.d_0_30.count, total: round(p.d_0_30.total) },
        d_31_60: { count: p.d_31_60.count, total: round(p.d_31_60.total) },
        d_60_plus: { count: p.d_60_plus.count, total: round(p.d_60_plus.total) },
        new_24h: {
          count: payNew.length,
          total: round(payNew.reduce((s, x) => s + x.amount, 0)),
        },
      },
    },
  });
}
