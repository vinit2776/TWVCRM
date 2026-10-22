/**
 * Loading one customer's cost base: the measured monthly figures and the cost
 * rates that apply (docs/plans/customer-value-phase5-cost-simulator.md).
 *
 * Shared by the Costs sub-tab (which simulates in the browser) and the renewal
 * outlook (which needs the break-even rent), so both read the same figures.
 * Read only. The lease is cost data only the rent-management roles can read, so
 * it is read with the service role: callers must have checked the user is an admin.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { loadCenterCohort } from "@/lib/customer-value/center-cohort";
import { buildCostsBase, BASE_WINDOW_MONTHS, type CostsBase, type CostsMonthRow } from "@/lib/customer-value/costs-base";
import { resolveParams, type CostParameterRow, type ResolvedParams } from "@/lib/customer-value/cost-parameters";
import { loadElectricity } from "@/lib/customer-value/electricity-load";
import { fetchInChunks } from "@/lib/customer-value/query-helpers";
import { shiftMonth } from "@/lib/energy-monthly";

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export interface CostsLoad {
  today: string;
  status: "ok" | "no_center" | "no_figures";
  center: { id: string; name: string } | null;
  base?: CostsBase["base"];
  months?: string[];
  params?: ResolvedParams["params"];
  sources?: ResolvedParams["sources"];
  electricityStatus?: string;
  ticketsLinked?: number;
}

export async function loadCostsBase(supabase: SupabaseClient, leadId: string, today: string): Promise<CostsLoad> {
  const cohort = await loadCenterCohort(supabase, leadId, "live");
  if (!cohort) return { today, status: "no_center", center: null };
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
  if (!built) return { today, status: "no_figures", center };

  const resolved = resolveParams((paramRes.data ?? []) as unknown as CostParameterRow[], { leadId, locationId: center.id, asOf: today });
  return {
    today,
    status: "ok",
    center,
    base: built.base,
    months: built.months,
    params: resolved.params,
    sources: resolved.sources,
    electricityStatus: electricity.status,
    ticketsLinked: issues.length,
  };
}
