/**
 * Loading one customer's electricity share (docs/plans/customer-value-phase4-electricity.md).
 *
 * Shared by the Electricity sub-tab and the Costs sub-tab, so both read the same
 * months and the same cost. Reads the local energy ledger (never a live OneGrid
 * call), the stored monthly seats, captured landlord bills and electricity
 * statements. When the center cannot be measured it says why (`status`) rather
 * than guessing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { istDateOf } from "@/lib/energy-baseline";
import { shiftMonth, trend } from "@/lib/energy-monthly";
import { loadMidnightReadings } from "@/lib/energy-midnights-server";
import type { CenterCohort } from "@/lib/customer-value/center-cohort";
import {
  blendedTariff,
  electricityMonth,
  summarise,
  type BillForTariff,
  type ElectricityMonth,
  type ElectricitySummary,
} from "@/lib/customer-value/electricity-share";
import { fetchInChunks } from "@/lib/customer-value/query-helpers";

const MONTHS = 12;

export type ElectricityStatus = "ok" | "no_center" | "no_meter" | "several_meters" | "no_capacity" | "no_readings";

export interface ElectricityResult {
  today: string;
  status: ElectricityStatus;
  center: { id: string; name: string } | null;
  capacity: number | null;
  months: ElectricityMonth[];
  summary: ElectricitySummary | null;
}

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const monthStart = (ym: string) => `${ym}-01`;

export interface CenterEnergy {
  status: Exclude<ElectricityStatus, "no_center">;
  capacity: number | null;
  /** The center meter's kWh per month, oldest first (empty unless status is ok). */
  energy: ReturnType<typeof trend>;
  /** Rupees per kWh for each month that has a priceable landlord bill. */
  tariffByMonth: Map<string, number | null>;
}

/**
 * The center-level half: which meter, how many seats, the meter's monthly kWh and
 * each month's tariff. Needs no customer, so the nightly margin job can read it
 * once per center and share it across every customer there.
 */
export async function loadCenterEnergy(supabase: SupabaseClient, centerId: string, today: string, months: number = MONTHS): Promise<CenterEnergy> {
  const none = (status: CenterEnergy["status"], capacity: number | null = null): CenterEnergy => ({ status, capacity, energy: [], tariffByMonth: new Map() });

  const [connRes, unitRes] = await Promise.all([
    supabase.from("location_electricity_connections").select("onegrid_device_id").eq("location_id", centerId).eq("is_active", true).not("onegrid_device_id", "is", null),
    supabase.from("space_units").select("capacity").eq("location_id", centerId).eq("is_active", true),
  ]);
  if (connRes.error) throw new Error(connRes.error.message);
  if (unitRes.error) throw new Error(unitRes.error.message);

  const devices = [...new Set((connRes.data ?? []).map((c) => c.onegrid_device_id as string))];
  if (devices.length === 0) return none("no_meter");
  // One meter at a time: summing a main and a sub meter would count the same power twice.
  if (devices.length > 1) return none("several_meters");

  const capacity = (unitRes.data ?? []).reduce((sum, u) => sum + (Number(u.capacity) || 0), 0);
  if (capacity <= 0) return none("no_capacity");

  const thisMonth = today.slice(0, 7);
  const firstMonth = shiftMonth(thisMonth, -(months - 1));
  const readings = await loadMidnightReadings(supabase, { locationId: centerId, deviceId: devices[0], from: monthStart(firstMonth), to: today });
  const { data: latestRow, error: latestError } = await supabase
    .from("location_energy_readings")
    .select("ts, cumulative_wh")
    .eq("location_id", centerId)
    .eq("device_id", devices[0])
    .not("cumulative_wh", "is", null)
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw new Error(latestError.message);
  const latest = latestRow ? { date: istDateOf(latestRow.ts as string), cumulative_wh: Number(latestRow.cumulative_wh) } : null;
  const energy = trend(thisMonth, months, readings, latest, today);
  if (energy.every((e) => e.kwh === null)) return none("no_readings", capacity);

  const billRes = await supabase
    .from("electricity_bills")
    .select("bill_month, bill_year, landlord_total_amount, electricity_bill_lines(line_type, units)")
    .eq("location_id", centerId)
    .eq("bill_side", "landlord")
    .neq("status", "revised")
    .gte("bill_year", Number(firstMonth.slice(0, 4)))
    .limit(200);
  if (billRes.error) throw new Error(billRes.error.message);
  const billsByMonth = new Map<string, BillForTariff[]>();
  for (const b of (billRes.data ?? []) as unknown as Array<{ bill_month: number; bill_year: number; landlord_total_amount: number | string | null; electricity_bill_lines: Array<{ line_type: string; units: number | string | null }> | null }>) {
    const ym = `${b.bill_year}-${String(b.bill_month).padStart(2, "0")}`;
    billsByMonth.set(ym, [...(billsByMonth.get(ym) ?? []), { landlord_total_amount: b.landlord_total_amount, lines: b.electricity_bill_lines ?? [] }]);
  }
  const tariffByMonth = new Map<string, number | null>();
  for (const e of energy) tariffByMonth.set(e.month, blendedTariff(billsByMonth.get(e.month) ?? []));

  return { status: "ok", capacity, energy, tariffByMonth };
}

export async function loadElectricity(supabase: SupabaseClient, leadId: string, cohort: CenterCohort | null, today: string): Promise<ElectricityResult> {
  const empty = (status: ElectricityStatus, center: ElectricityResult["center"] = null, capacity: number | null = null): ElectricityResult => ({
    today, status, center, capacity, months: [], summary: null,
  });
  if (!cohort) return empty("no_center");
  const center = { id: cohort.centerId, name: cohort.centerName };

  const ce = await loadCenterEnergy(supabase, center.id, today);
  if (ce.status !== "ok" || ce.capacity === null) return empty(ce.status, center, ce.capacity);
  const { capacity, energy } = ce;

  const firstMonth = shiftMonth(today.slice(0, 7), -(MONTHS - 1));
  const hisContracts = cohort.contracts.filter((c) => c.location_id === center.id).map((c) => c.id);
  const [monthlyRows, statementRows] = await Promise.all([
    fetchInChunks<{ lead_id: string; month: string; seats_paid: number | string | null }>("seats", cohort.leadIds, (batch, from, to) =>
      supabase.from("customer_value_monthly").select("lead_id, month, seats_paid").in("lead_id", batch).gte("month", monthStart(firstMonth)).order("lead_id").order("month").range(from, to)
    ),
    fetchInChunks<{ id: string; period_start: string; subtotal: number | string | null }>("electricity statements", hisContracts, (batch, from, to) =>
      supabase.from("billing_statements").select("id, period_start, subtotal").in("contract_id", batch).eq("statement_type", "electricity").in("status", ["finalized", "exported"]).gte("period_start", monthStart(firstMonth)).order("id").range(from, to)
    ),
  ]);

  const seatsByMonth = new Map<string, { mine: number | null; all: number }>();
  for (const r of monthlyRows) {
    const ym = r.month.slice(0, 7);
    const seats = n(r.seats_paid) ?? 0;
    const cur = seatsByMonth.get(ym) ?? { mine: null, all: 0 };
    cur.all += seats;
    if (r.lead_id === leadId) cur.mine = seats;
    seatsByMonth.set(ym, cur);
  }

  const billedByMonth = new Map<string, number>();
  for (const s of statementRows) {
    const ym = s.period_start.slice(0, 7);
    billedByMonth.set(ym, (billedByMonth.get(ym) ?? 0) + (n(s.subtotal) ?? 0));
  }

  const months = energy.flatMap((e) => {
    const seats = seatsByMonth.get(e.month);
    // Months before he had any seats are left out rather than shown as empty rows.
    if (!seats || !(seats.mine && seats.mine > 0)) return [];
    return [electricityMonth({
      month: e.month, centerKwh: e.kwh, partial: e.partial, unknownDays: e.unknownDays,
      seats: seats.mine, contractedSeats: seats.all,
      tariff: ce.tariffByMonth.get(e.month) ?? null,
      billed: billedByMonth.has(e.month) ? (billedByMonth.get(e.month) as number) : null,
    }, capacity)];
  });

  return { today, status: "ok", center, capacity, months, summary: summarise(months) };
}
