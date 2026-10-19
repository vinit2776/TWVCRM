/**
 * GET /api/leads/[id]/value/electricity
 *
 * Electricity sub-tab of the lead's Value tab (docs/plans/customer-value-phase4-electricity.md):
 * this customer's share of the center's metered electricity by month, what it
 * costs, and whether what they were billed covers it.
 *
 * Read only; admin only. Reads the local energy ledger (never a live OneGrid
 * call), the stored monthly seats, captured landlord bills and electricity
 * statements. When the center cannot be measured the response says why
 * (`status`) instead of guessing: no mapped meter, several meters (the ledger
 * must be read one meter at a time or it double counts), or no seat capacity.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { istDateOf, istToday } from "@/lib/energy-baseline";
import { shiftMonth, trend } from "@/lib/energy-monthly";
import { loadMidnightReadings } from "@/lib/energy-midnights-server";
import { loadCenterCohort } from "@/lib/customer-value/center-cohort";
import {
  blendedTariff,
  electricityMonth,
  summarise,
  type BillForTariff,
  type ElectricityMonth,
  type ElectricitySummary,
} from "@/lib/customer-value/electricity-share";
import { fetchInChunks } from "@/lib/customer-value/query-helpers";

export const maxDuration = 30;

const paramsSchema = z.object({ id: z.string().uuid() });
const MONTHS = 12;

type Status = "ok" | "no_center" | "no_meter" | "several_meters" | "no_capacity" | "no_readings";

interface Body {
  today: string;
  status: Status;
  center: { id: string; name: string } | null;
  capacity: number | null;
  months: ElectricityMonth[];
  summary: ElectricitySummary | null;
}

const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const monthStart = (ym: string) => `${ym}-01`;

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
  const cache = { "Cache-Control": "private, max-age=60, stale-while-revalidate=120" };
  const empty = (status: Status, center: Body["center"] = null, capacity: number | null = null): Body => ({
    today, status, center, capacity, months: [], summary: null,
  });

  try {
    const cohort = await loadCenterCohort(supabase, leadId);
    if (!cohort) return NextResponse.json(empty("no_center"), { headers: cache });
    const center = { id: cohort.centerId, name: cohort.centerName };

    const [connRes, unitRes] = await Promise.all([
      supabase.from("location_electricity_connections").select("onegrid_device_id").eq("location_id", center.id).eq("is_active", true).not("onegrid_device_id", "is", null),
      supabase.from("space_units").select("capacity").eq("location_id", center.id).eq("is_active", true),
    ]);
    if (connRes.error) throw new Error(connRes.error.message);
    if (unitRes.error) throw new Error(unitRes.error.message);

    const devices = [...new Set((connRes.data ?? []).map((c) => c.onegrid_device_id as string))];
    if (devices.length === 0) return NextResponse.json(empty("no_meter", center), { headers: cache });
    // One meter at a time: summing a main and a sub meter would count the same power twice.
    if (devices.length > 1) return NextResponse.json(empty("several_meters", center), { headers: cache });

    const capacity = (unitRes.data ?? []).reduce((sum, u) => sum + (Number(u.capacity) || 0), 0);
    if (capacity <= 0) return NextResponse.json(empty("no_capacity", center), { headers: cache });

    const thisMonth = today.slice(0, 7);
    const firstMonth = shiftMonth(thisMonth, -(MONTHS - 1));
    const readings = await loadMidnightReadings(supabase, { locationId: center.id, deviceId: devices[0], from: monthStart(firstMonth), to: today });
    const { data: latestRow, error: latestError } = await supabase
      .from("location_energy_readings")
      .select("ts, cumulative_wh")
      .eq("location_id", center.id)
      .eq("device_id", devices[0])
      .not("cumulative_wh", "is", null)
      .order("ts", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestError) throw new Error(latestError.message);
    const latest = latestRow
      ? { date: istDateOf(latestRow.ts as string), cumulative_wh: Number(latestRow.cumulative_wh) }
      : null;
    const energy = trend(thisMonth, MONTHS, readings, latest, today);
    if (energy.every((e) => e.kwh === null)) return NextResponse.json(empty("no_readings", center, capacity), { headers: cache });

    const hisContracts = cohort.contracts.filter((c) => c.location_id === center.id).map((c) => c.id);
    const [monthlyRows, billRows, statementRows] = await Promise.all([
      fetchInChunks<{ lead_id: string; month: string; seats_paid: number | string | null }>("seats", cohort.leadIds, (batch, from, to) =>
        supabase.from("customer_value_monthly").select("lead_id, month, seats_paid").in("lead_id", batch).gte("month", monthStart(firstMonth)).order("lead_id").order("month").range(from, to)
      ),
      supabase
        .from("electricity_bills")
        .select("bill_month, bill_year, landlord_total_amount, electricity_bill_lines(line_type, units)")
        .eq("location_id", center.id)
        .eq("bill_side", "landlord")
        .neq("status", "revised")
        .gte("bill_year", Number(firstMonth.slice(0, 4)))
        .limit(200),
      fetchInChunks<{ id: string; period_start: string; subtotal: number | string | null }>("electricity statements", hisContracts, (batch, from, to) =>
        supabase.from("billing_statements").select("id, period_start, subtotal").in("contract_id", batch).eq("statement_type", "electricity").in("status", ["finalized", "exported"]).gte("period_start", monthStart(firstMonth)).order("id").range(from, to)
      ),
    ]);
    if (billRows.error) throw new Error(billRows.error.message);

    const seatsByMonth = new Map<string, { mine: number | null; all: number }>();
    for (const r of monthlyRows) {
      const ym = r.month.slice(0, 7);
      const seats = n(r.seats_paid) ?? 0;
      const cur = seatsByMonth.get(ym) ?? { mine: null, all: 0 };
      cur.all += seats;
      if (r.lead_id === leadId) cur.mine = seats;
      seatsByMonth.set(ym, cur);
    }

    const billsByMonth = new Map<string, BillForTariff[]>();
    for (const b of (billRows.data ?? []) as unknown as Array<{ bill_month: number; bill_year: number; landlord_total_amount: number | string | null; electricity_bill_lines: Array<{ line_type: string; units: number | string | null }> | null }>) {
      const ym = `${b.bill_year}-${String(b.bill_month).padStart(2, "0")}`;
      billsByMonth.set(ym, [...(billsByMonth.get(ym) ?? []), { landlord_total_amount: b.landlord_total_amount, lines: b.electricity_bill_lines ?? [] }]);
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
        tariff: blendedTariff(billsByMonth.get(e.month) ?? []),
        billed: billedByMonth.has(e.month) ? (billedByMonth.get(e.month) as number) : null,
      }, capacity)];
    });

    const body: Body = { today, status: "ok", center, capacity, months, summary: summarise(months) };
    return NextResponse.json(body, { headers: cache });
  } catch (err) {
    console.error("[api/leads/value/electricity] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to load electricity" }, { status: 500 });
  }
}
