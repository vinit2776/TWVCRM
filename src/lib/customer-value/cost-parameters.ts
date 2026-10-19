/**
 * Customer Value — the cost parameters an admin enters, and which value applies.
 *
 * Pure: the admin API loads and writes `value_cost_parameters` rows; this decides
 * what is valid and which value is in force. Rows are an append-only history (see
 * migration 00628), so a past month always resolves to the rate that applied then.
 */

import { z } from "zod";
import type { CostParams } from "@/lib/customer-value/cost-simulator";

export const COST_PARAMETER_KEYS = [
  "hourly_staff_cost",
  "cost_of_capital_pct",
  "pantry_per_person_day",
  "acquisition_cost",
  "housekeeping_per_seat",
  "maintenance_per_seat",
  "front_desk_per_seat",
  "internet_per_seat",
  "overhead_pct",
] as const;
export type CostParameterKey = (typeof COST_PARAMETER_KEYS)[number];

export interface CostParameterDef {
  key: CostParameterKey;
  /** The simulator input this feeds. */
  param: keyof CostParams;
  label: string;
  unit: string;
  help: string;
  /** Highest value accepted: a percentage cannot pass 100, a rupee figure has a sanity ceiling. */
  max: number;
}

export const COST_PARAMETER_DEFS: CostParameterDef[] = [
  { key: "hourly_staff_cost", param: "hourlyStaffCost", label: "Facility staff cost", unit: "₹ per hour", help: "Turns logged ticket time into rupees.", max: 100_000 },
  { key: "cost_of_capital_pct", param: "costOfCapitalPct", label: "Cost of capital", unit: "% per year", help: "What late payment costs: invoice value × days late ÷ 365 × this.", max: 100 },
  { key: "pantry_per_person_day", param: "pantryPerPersonDay", label: "Pantry and consumables", unit: "₹ per person-day", help: "Needs door-access data to count person-days.", max: 100_000 },
  { key: "acquisition_cost", param: "acquisitionCost", label: "Acquisition cost", unit: "₹ one-off", help: "Commission or spend to win the customer, spread over their tenure. Usually set per customer.", max: 100_000_000 },
  { key: "housekeeping_per_seat", param: "housekeepingPerSeat", label: "Housekeeping", unit: "₹ per seat per month", help: "", max: 1_000_000 },
  { key: "maintenance_per_seat", param: "maintenancePerSeat", label: "Maintenance and AMC", unit: "₹ per seat per month", help: "", max: 1_000_000 },
  { key: "front_desk_per_seat", param: "frontDeskPerSeat", label: "Front desk and admin", unit: "₹ per seat per month", help: "", max: 1_000_000 },
  { key: "internet_per_seat", param: "internetPerSeat", label: "Internet", unit: "₹ per seat per month", help: "A flat figure until there is a center bill to split by traffic.", max: 1_000_000 },
  { key: "overhead_pct", param: "overheadPct", label: "Head-office overhead", unit: "% of revenue", help: "Only counts in the fully-loaded margin. Leave empty to keep it out.", max: 100 },
];

const DEF_BY_KEY = new Map(COST_PARAMETER_DEFS.map((d) => [d.key, d]));

export type CostParameterScope = "global" | "location" | "lead";

export interface CostParameterRow {
  id: string;
  scope: CostParameterScope;
  location_id: string | null;
  lead_id: string | null;
  key: CostParameterKey;
  /** Null = cleared from `effective_from`. */
  value: number | null;
  /** YYYY-MM-DD */
  effective_from: string;
  created_at: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const todayPlus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** Body of POST /api/admin/customer-value/cost-parameters. */
export const costParameterWriteSchema = z
  .object({
    scope: z.enum(["global", "location", "lead"]),
    location_id: z.string().uuid().nullish(),
    lead_id: z.string().uuid().nullish(),
    key: z.enum(COST_PARAMETER_KEYS),
    /** Null clears the value from `effective_from`. */
    value: z.number().finite().min(0).nullable(),
    effective_from: z.string().regex(YMD, "Use a YYYY-MM-DD date"),
  })
  .strict()
  .superRefine((d, ctx) => {
    const wantLocation = d.scope === "location";
    const wantLead = d.scope === "lead";
    if (wantLocation !== Boolean(d.location_id)) ctx.addIssue({ code: "custom", path: ["location_id"], message: wantLocation ? "location_id is required for a center value" : "location_id only applies to a center value" });
    if (wantLead !== Boolean(d.lead_id)) ctx.addIssue({ code: "custom", path: ["lead_id"], message: wantLead ? "lead_id is required for a customer value" : "lead_id only applies to a customer value" });
    const def = DEF_BY_KEY.get(d.key);
    if (def && d.value !== null && d.value > def.max) ctx.addIssue({ code: "custom", path: ["value"], message: `${def.label} cannot be more than ${def.max.toLocaleString("en-IN")}` });
    if (d.effective_from < "2020-01-01" || d.effective_from > todayPlus(400) || Number.isNaN(Date.parse(d.effective_from))) {
      ctx.addIssue({ code: "custom", path: ["effective_from"], message: "Pick a date between 2020 and a year from now" });
    }
  });

function rowsAt(rows: CostParameterRow[], scope: CostParameterScope, ids: { locationId?: string | null; leadId?: string | null }, key: CostParameterKey, asOf: string): CostParameterRow[] {
  return rows.filter(
    (r) =>
      r.key === key &&
      r.scope === scope &&
      r.effective_from <= asOf &&
      (scope === "global" || (scope === "location" ? r.location_id === ids.locationId : r.lead_id === ids.leadId))
  );
}

/** The latest row in force at one scope for a month, or null when none was set or the latest one clears it. */
export function inForce(rows: CostParameterRow[], scope: CostParameterScope, ids: { locationId?: string | null; leadId?: string | null }, key: CostParameterKey, asOf: string): CostParameterRow | null {
  const latest = rowsAt(rows, scope, ids, key, asOf).sort((a, b) => (a.effective_from === b.effective_from ? (a.created_at < b.created_at ? 1 : -1) : a.effective_from < b.effective_from ? 1 : -1))[0];
  return latest && latest.value !== null ? latest : null;
}

export interface ResolvedParams {
  params: CostParams;
  /** Where each value came from, so the page can say "set for this customer" or "center default". */
  sources: Partial<Record<keyof CostParams, { scope: CostParameterScope; effective_from: string }>>;
}

/** The parameters for a customer and month: customer value, else center value, else global, else not entered. */
export function resolveParams(rows: CostParameterRow[], ctx: { leadId?: string | null; locationId?: string | null; asOf: string }): ResolvedParams {
  const params: CostParams = {};
  const sources: ResolvedParams["sources"] = {};
  for (const def of COST_PARAMETER_DEFS) {
    for (const scope of ["lead", "location", "global"] as const) {
      if ((scope === "lead" && !ctx.leadId) || (scope === "location" && !ctx.locationId)) continue;
      const row = inForce(rows, scope, { leadId: ctx.leadId, locationId: ctx.locationId }, def.key, ctx.asOf);
      if (row && row.value !== null) {
        params[def.param] = Number(row.value);
        sources[def.param] = { scope, effective_from: row.effective_from };
        break;
      }
    }
  }
  return { params, sources };
}
