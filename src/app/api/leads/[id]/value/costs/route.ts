/**
 * GET /api/leads/[id]/value/costs
 *
 * Costs sub-tab of the lead's Value tab (docs/plans/customer-value-phase5-cost-simulator.md):
 * one customer's measured monthly figures and the cost rates that apply to them.
 * The page does the arithmetic in the browser (`simulate`), so the what-if sliders
 * are instant and only this one small payload is fetched.
 *
 * Measured from stored data: revenue, seats, rent per seat, concessions and days
 * late (the stored monthly rows), electricity (the phase 4 share), staff time
 * (minutes logged on tickets explicitly tied to this customer), and the center's
 * lease. Rates come from `value_cost_parameters` (customer, then center, then
 * global). Anything not measured is null, never zero. Read only; admin only.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { istToday } from "@/lib/energy-baseline";
import { loadCenterCohort } from "@/lib/customer-value/center-cohort";
import { buildCostsBase, BASE_WINDOW_MONTHS, type CostsMonthRow } from "@/lib/customer-value/costs-base";
import { resolveParams, type CostParameterRow } from "@/lib/customer-value/cost-parameters";
import { loadElectricity } from "@/lib/customer-value/electricity-load";
import { fetchInChunks } from "@/lib/customer-value/query-helpers";
import { shiftMonth } from "@/lib/energy-monthly";

export const maxDuration = 30;

const paramsSchema = z.object({ id: z.string().uuid() });

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  const leadId = parsed.data.id;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (dbUser?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const today = istToday();
  const cache = { "Cache-Control": "private, no-store" };

  try {
    const cohort = await loadCenterCohort(supabase, leadId, "live");
    if (!cohort) return NextResponse.json({ today, status: "no_center", center: null }, { headers: cache });
    const center = { id: cohort.centerId, name: cohort.centerName };

    const windowStart = `${shiftMonth(today.slice(0, 7), -BASE_WINDOW_MONTHS)}-01`;
    const centerContractIds = cohort.contracts.filter((c) => c.location_id === center.id).map((c) => c.id);

    const [electricity, monthlyRes, startsRes, issues, leaseRes, unitRes, paramRes] = await Promise.all([
      loadElectricity(supabase, leadId, cohort, today),
      supabase
        .from("customer_value_monthly")
        .select("month, revenue_ex_gst, avg_days_late, measured_count, concessions_counted, seats_paid, seats_used_avg, rent_per_seat")
        .eq("lead_id", leadId)
        .gte("month", windowStart)
        .order("month")
        .limit(24),
      supabase.from("contracts").select("start_date").eq("lead_id", leadId).order("start_date").limit(1),
      fetchInChunks<{ id: string }>("linked tickets", centerContractIds, (batch, from, to) =>
        supabase.from("facility_issues").select("id").in("contract_id", batch).order("id").range(from, to)
      ),
      // The lease is cost data only the rent-management roles can read, so the sum is read server-side after the admin check above.
      createAdminClient()
        .from("property_leases")
        .select("base_rent_amount")
        .eq("location_id", center.id)
        .eq("status", "active")
        .lte("lease_start_date", today)
        .gte("lease_end_date", today),
      supabase.from("space_units").select("capacity").eq("location_id", center.id).eq("is_active", true),
      supabase
        .from("value_cost_parameters")
        .select("id, scope, location_id, lead_id, key, value, effective_from, created_at")
        .or(`scope.eq.global,and(scope.eq.location,location_id.eq.${center.id}),and(scope.eq.lead,lead_id.eq.${leadId})`)
        .limit(2000),
    ]);
    for (const r of [monthlyRes, startsRes, leaseRes, unitRes, paramRes]) if (r.error) throw new Error(r.error.message);

    const logs = await fetchInChunks<{ minutes: number }>("ticket time", issues.map((i) => i.id), (batch, from, to) =>
      supabase.from("facility_issue_time_logs").select("minutes, id").in("issue_id", batch).gte("logged_at", `${windowStart}T00:00:00+05:30`).order("id").range(from, to)
    );
    const staffMinutes = logs.reduce((s, l) => s + Number(l.minutes), 0);

    const leaseRows = leaseRes.data ?? [];
    const centerLease = leaseRows.length > 0 ? leaseRows.reduce((s, l) => s + Number(l.base_rent_amount), 0) : null;
    const centerSeats = electricity.capacity ?? ((unitRes.data ?? []).reduce((s, u) => s + (Number(u.capacity) || 0), 0) || null);

    const rows: CostsMonthRow[] = (monthlyRes.data ?? []).map((r) => ({
      month: r.month as string,
      revenue_ex_gst: Number(r.revenue_ex_gst) || 0,
      avg_days_late: n(r.avg_days_late),
      measured_count: Number(r.measured_count) || 0,
      concessions_counted: Number(r.concessions_counted) || 0,
      seats_paid: n(r.seats_paid),
      seats_used_avg: n(r.seats_used_avg),
      rent_per_seat: n(r.rent_per_seat),
    }));

    const built = buildCostsBase({
      rows,
      today,
      electricityMonths: electricity.status === "ok" ? electricity.months : null,
      ticketsLinked: issues.length,
      staffMinutes,
      firstContractStart: (startsRes.data?.[0]?.start_date as string | undefined) ?? null,
      centerLease,
      centerSeats,
    });
    if (!built) return NextResponse.json({ today, status: "no_figures", center }, { headers: cache });

    const resolved = resolveParams((paramRes.data ?? []) as unknown as CostParameterRow[], { leadId, locationId: center.id, asOf: today });
    return NextResponse.json(
      {
        today,
        status: "ok",
        center,
        base: built.base,
        months: built.months,
        params: resolved.params,
        sources: resolved.sources,
        electricityStatus: electricity.status,
        ticketsLinked: issues.length,
      },
      { headers: cache }
    );
  } catch (err) {
    console.error("[api/leads/value/costs] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to load costs" }, { status: 500 });
  }
}
