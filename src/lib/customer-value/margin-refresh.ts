/**
 * Customer Value — computing and storing the shadow margin
 * (docs/plans/customer-value-phase5-cost-simulator.md, section 5).
 *
 * Reads the stored monthly figures (`customer_value_monthly`) and the cost
 * rates in force each month, adds the center's electricity and the minutes logged
 * on tickets tied to each customer, and writes margin after variable costs to
 * `customer_value_margin`. Scoring is untouched. Dry-run is the default; it reads
 * CRM records, writes only that table, and sends nothing to anyone.
 *
 * A customer's center is the one scoring uses (their first location), so the
 * electricity split matches the Electricity tab.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveParams, type CostParameterRow } from "@/lib/customer-value/cost-parameters";
import { electricityMonth } from "@/lib/customer-value/electricity-share";
import { loadCenterEnergy, type CenterEnergy } from "@/lib/customer-value/electricity-load";
import { fetchAllPages, fetchInChunks } from "@/lib/customer-value/query-helpers";
import { primaryLocation } from "@/lib/customer-value/scoring-run";
import { shadowMargin, tenureAt, type ShadowMargin } from "@/lib/customer-value/shadow-margin";
import { upsertInChunks } from "@/lib/customer-value/snapshot-refresh";

/** The ledger only goes back so far; two years covers every month a customer could have. */
const ENERGY_MONTHS = 24;
const IST_MS = 5.5 * 3_600_000;

interface MonthlyRow {
  lead_id: string;
  month: string;
  revenue_ex_gst: number | string;
  seats_paid: number | string | null;
  rent_per_seat: number | string | null;
  concessions_counted: number | string;
  avg_days_late: number | string | null;
  measured_count: number | string;
  seats_used_avg: number | string | null;
}

export interface MarginRecord {
  lead_id: string;
  month: string;
  revenue: number;
  variable_cost: number;
  margin_after_variable: number;
  margin_pct: number | null;
  confidence: number | null;
  lines: ShadowMargin["lines"];
  computed_at: string;
}

export interface MarginRefreshResult {
  wrote: boolean;
  customers: number;
  rows: number;
  /** Rows whose electricity cost could be measured. */
  withElectricity: number;
  warnings: string[];
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const istMonth = (iso: string) => new Date(Date.parse(iso) + IST_MS).toISOString().slice(0, 7);

export async function refreshShadowMargins(
  supabase: SupabaseClient,
  today: string,
  options: { write: boolean } = { write: false }
): Promise<MarginRefreshResult> {
  const warnings: string[] = [];
  const thisMonth = `${today.slice(0, 7)}-01`;

  const [monthlyAll, contracts, paramRows] = await Promise.all([
    fetchAllPages<MonthlyRow>("monthly rows", (from, to) =>
      supabase
        .from("customer_value_monthly")
        .select("lead_id, month, revenue_ex_gst, seats_paid, rent_per_seat, concessions_counted, avg_days_late, measured_count, seats_used_avg")
        .lt("month", thisMonth)
        .order("lead_id")
        .order("month")
        .range(from, to)
        .returns<MonthlyRow[]>()
    ),
    fetchAllPages<{ id: string; lead_id: string; location_id: string | null; start_date: string | null }>("contracts", (from, to) =>
      supabase.from("contracts").select("id, lead_id, location_id, start_date").order("id").range(from, to).returns<Array<{ id: string; lead_id: string; location_id: string | null; start_date: string | null }>>()
    ),
    fetchAllPages<CostParameterRow>("cost parameters", (from, to) =>
      supabase.from("value_cost_parameters").select("id, scope, location_id, lead_id, key, value, effective_from, created_at").order("id").range(from, to).returns<CostParameterRow[]>()
    ),
  ]);

  // Each customer's center and first contract start.
  const locationsByLead = new Map<string, string[]>();
  const startByLead = new Map<string, string>();
  const leadByContract = new Map<string, string>();
  for (const c of contracts) {
    leadByContract.set(c.id, c.lead_id);
    if (c.location_id) locationsByLead.set(c.lead_id, [...(locationsByLead.get(c.lead_id) ?? []), c.location_id]);
    if (c.start_date && (!startByLead.has(c.lead_id) || c.start_date < (startByLead.get(c.lead_id) as string))) startByLead.set(c.lead_id, c.start_date);
  }
  const centerByLead = new Map<string, string | null>();
  for (const [lead, locs] of locationsByLead) centerByLead.set(lead, primaryLocation({ locationIds: locs }));

  // Seats of everyone at each center, by month: the electricity split's denominator.
  const contractedByCenterMonth = new Map<string, number>();
  for (const r of monthlyAll) {
    const center = centerByLead.get(r.lead_id);
    if (!center) continue;
    const key = `${center}|${r.month.slice(0, 7)}`;
    contractedByCenterMonth.set(key, (contractedByCenterMonth.get(key) ?? 0) + (num(r.seats_paid) ?? 0));
  }

  // The center-level electricity, once per center.
  const centers = [...new Set(monthlyAll.map((r) => centerByLead.get(r.lead_id)).filter((c): c is string => Boolean(c)))];
  const energyByCenter = new Map<string, CenterEnergy>();
  for (const centerId of centers) {
    try {
      energyByCenter.set(centerId, await loadCenterEnergy(supabase, centerId, today, ENERGY_MONTHS));
    } catch (err) {
      warnings.push(`electricity unavailable for one center: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  // Minutes logged on tickets explicitly tied to each customer, by month.
  const issues = await fetchInChunks<{ id: string; contract_id: string }>("linked tickets", [...leadByContract.keys()], (batch, from, to) =>
    supabase.from("facility_issues").select("id, contract_id").in("contract_id", batch).order("id").range(from, to)
  );
  const leadByIssue = new Map(issues.map((i) => [i.id, leadByContract.get(i.contract_id) as string]));
  const ticketsByLead = new Map<string, number>();
  for (const lead of leadByIssue.values()) ticketsByLead.set(lead, (ticketsByLead.get(lead) ?? 0) + 1);
  const logs = await fetchInChunks<{ id: string; issue_id: string; minutes: number; logged_at: string }>("ticket time", [...leadByIssue.keys()], (batch, from, to) =>
    supabase.from("facility_issue_time_logs").select("id, issue_id, minutes, logged_at").in("issue_id", batch).order("id").range(from, to)
  );
  const minutesByLeadMonth = new Map<string, number>();
  for (const l of logs) {
    const lead = leadByIssue.get(l.issue_id);
    if (!lead) continue;
    const key = `${lead}|${istMonth(l.logged_at)}`;
    minutesByLeadMonth.set(key, (minutesByLeadMonth.get(key) ?? 0) + Number(l.minutes));
  }

  const computedAt = new Date().toISOString();
  const records: MarginRecord[] = [];
  let withElectricity = 0;
  for (const r of monthlyAll) {
    const center = centerByLead.get(r.lead_id) ?? null;
    const ym = r.month.slice(0, 7);
    const seats = num(r.seats_paid);

    let electricityCost: number | null = null;
    const energy = center ? energyByCenter.get(center) : undefined;
    if (energy && energy.status === "ok" && energy.capacity !== null && seats !== null && seats > 0) {
      const point = energy.energy.find((e) => e.month === ym);
      if (point && !point.partial) {
        electricityCost = electricityMonth(
          {
            month: ym, centerKwh: point.kwh, partial: false, unknownDays: point.unknownDays, seats,
            contractedSeats: contractedByCenterMonth.get(`${center}|${ym}`) ?? seats,
            tariff: energy.tariffByMonth.get(ym) ?? null, billed: null,
          },
          energy.capacity
        ).cost;
      }
    }

    const m = shadowMargin({
      month: r.month,
      revenue_ex_gst: Number(r.revenue_ex_gst) || 0,
      seats_paid: seats,
      rent_per_seat: num(r.rent_per_seat),
      concessions_counted: Number(r.concessions_counted) || 0,
      avg_days_late: num(r.avg_days_late),
      measured_count: Number(r.measured_count) || 0,
      seats_used_avg: num(r.seats_used_avg),
      electricityCost,
      staffMinutes: (ticketsByLead.get(r.lead_id) ?? 0) > 0 ? (minutesByLeadMonth.get(`${r.lead_id}|${ym}`) ?? 0) : null,
      tenureMonths: tenureAt(startByLead.get(r.lead_id) ?? null, r.month),
      params: resolveParams(paramRows, { leadId: r.lead_id, locationId: center, asOf: r.month }).params,
    });
    if (!m) continue;
    if (electricityCost !== null) withElectricity++;
    records.push({
      lead_id: r.lead_id,
      month: m.month,
      revenue: m.revenue,
      variable_cost: m.variable_cost,
      margin_after_variable: m.margin_after_variable,
      margin_pct: m.margin_pct,
      confidence: m.confidence,
      lines: m.lines,
      computed_at: computedAt,
    });
  }

  if (options.write) await upsertInChunks(supabase, "customer_value_margin", records, "lead_id,month");
  return { wrote: options.write, customers: new Set(records.map((r) => r.lead_id)).size, rows: records.length, withElectricity, warnings };
}
