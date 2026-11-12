/**
 * GET /api/leads/[id]/value/performance
 *
 * Performance sub-tab of the lead's Value tab (docs/plans/customer-value-phase2.md,
 * section 7): the stored score history (the four pillars over time) and the
 * stored monthly figures (days to pay, seats, tickets).
 *
 * Two small reads of precomputed rows, never an aggregation over live records.
 * Always returns the full two-year window; the range switcher in the page only
 * re-slices what was fetched. Read only; admin only; uses the signed-in user's
 * client so the tables' admin-only RLS policies apply as a second gate.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { todayYmdIst } from "@/lib/customer-value/journey";
import type { PerfMonthRow, PerfScoreRow } from "@/lib/customer-value/performance-view";

export const maxDuration = 30;

const paramsSchema = z.object({ id: z.string().uuid() });

const WINDOW_DAYS = 740;

function daysBefore(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  const leadId = parsed.data.id;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (dbUser?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const today = todayYmdIst();
  const since = daysBefore(today, WINDOW_DAYS);

  const [scoresRes, monthlyRes] = await Promise.all([
    supabase
      .from("customer_value_scores")
      .select("as_of, payment, friction, engagement, profitability, overall, tier, status")
      .eq("lead_id", leadId)
      .gte("as_of", since)
      .order("as_of", { ascending: true })
      .limit(1500)
      .returns<PerfScoreRow[]>(),
    supabase
      .from("customer_value_monthly")
      .select(
        "month, avg_days_late, measured_count, on_time_count, seats_paid, seats_used_avg, tickets_linked, tickets_unlinked, tickets_sla_breached, data_flags"
      )
      .eq("lead_id", leadId)
      .gte("month", since)
      .order("month", { ascending: true })
      .limit(60)
      .returns<PerfMonthRow[]>(),
  ]);

  if (scoresRes.error || monthlyRes.error) {
    console.error("[api/leads/value/performance] query failed:", scoresRes.error?.message ?? monthlyRes.error?.message);
    return NextResponse.json({ error: "Failed to load performance" }, { status: 500 });
  }

  // Numeric columns can arrive as strings; the charts need numbers.
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const scores = (scoresRes.data ?? []).map((r) => ({
    ...r,
    payment: n(r.payment), friction: n(r.friction), engagement: n(r.engagement), profitability: n(r.profitability), overall: n(r.overall),
  }));
  const monthly = (monthlyRes.data ?? []).map((r) => ({
    ...r,
    avg_days_late: n(r.avg_days_late), seats_paid: n(r.seats_paid), seats_used_avg: n(r.seats_used_avg),
  }));

  return NextResponse.json(
    { today, scores, monthly },
    { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=120" } }
  );
}
