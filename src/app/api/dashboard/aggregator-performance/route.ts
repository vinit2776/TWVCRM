import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/aggregator-performance
 * Per-aggregator: active cases, total contract value, sent-not-paid invoice
 * outstanding (this year). Sorted by outstanding desc.
 *
 * Access: admin, manager, accounts.
 */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();
  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser || !["admin", "manager", "accounts"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const year = new Date().getFullYear();

  const [
    { data: aggregators },
    { data: cases },
    { data: invoices },
  ] = await Promise.all([
    adminSupabase
      .from("aggregators")
      .select("id, name, status")
      .eq("status", "active"),
    adminSupabase
      .from("cases")
      .select("id, aggregator_id, status, total_amount, rate, start_date, end_date"),
    adminSupabase
      .from("aggregator_invoices")
      .select("id, aggregator_id, status, total_amount, period_year")
      .eq("period_year", year)
      .in("status", ["sent", "overdue", "paid"]),
  ]);

  type Agg = { id: string; name: string };
  type Case = { aggregator_id: string; status: string; total_amount: number | null; rate: number | null };
  type Inv = { aggregator_id: string; status: string; total_amount: number | null };

  type Row = {
    id: string;
    name: string;
    active_cases: number;
    total_value: number;
    invoiced_ytd: number;
    outstanding_ytd: number;
  };

  const map = new Map<string, Row>();
  for (const a of (aggregators ?? []) as Agg[]) {
    map.set(a.id, {
      id: a.id,
      name: a.name,
      active_cases: 0,
      total_value: 0,
      invoiced_ytd: 0,
      outstanding_ytd: 0,
    });
  }

  for (const c of (cases ?? []) as Case[]) {
    const r = map.get(c.aggregator_id);
    if (!r) continue;
    // Active cases = anything not closed/terminated
    if (!["closed", "terminated", "cancelled"].includes(c.status)) {
      r.active_cases += 1;
      r.total_value += Number(c.total_amount ?? c.rate ?? 0);
    }
  }

  for (const i of (invoices ?? []) as Inv[]) {
    const r = map.get(i.aggregator_id);
    if (!r) continue;
    const amt = Number(i.total_amount ?? 0);
    r.invoiced_ytd += amt;
    if (i.status !== "paid") r.outstanding_ytd += amt;
  }

  const list = Array.from(map.values())
    .filter((r) => r.active_cases > 0 || r.invoiced_ytd > 0)
    .sort((a, b) => b.outstanding_ytd - a.outstanding_ytd || b.total_value - a.total_value)
    .slice(0, 8)
    .map((r) => ({
      ...r,
      total_value: Math.round(r.total_value),
      invoiced_ytd: Math.round(r.invoiced_ytd),
      outstanding_ytd: Math.round(r.outstanding_ytd),
    }));

  const totalOutstanding = list.reduce((s, r) => s + r.outstanding_ytd, 0);
  const totalActiveCases = list.reduce((s, r) => s + r.active_cases, 0);

  return NextResponse.json({
    data: {
      total_aggregators: list.length,
      total_active_cases: totalActiveCases,
      total_outstanding_ytd: Math.round(totalOutstanding),
      aggregators: list,
    },
  });
}
