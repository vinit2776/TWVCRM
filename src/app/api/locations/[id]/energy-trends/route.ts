import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import {
  aggregateDaily, computeBaselines, findAnomalies, weekdayProfile, addDays, istToday,
  type LedgerBucket, type HolidayEntry,
} from "@/lib/energy-baseline";

// Read-only analytics over the local ledger (location_energy_readings) — never
// calls OneGrid. Always loads the widest baseline window (365 days) so the
// 30-day / quarterly / annual baselines come from one pass.
const PAGE = 1000; // PostgREST's default max rows per request
const MAX_PAGES = 60; // 60k buckets ≈ 625 days of one meter — hard stop against runaway loops

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // One meter at a time: summing several meters (e.g. main + sub) would double count.
  const deviceId = request.nextUrl.searchParams.get("device_id");
  if (!deviceId) return NextResponse.json({ error: "device_id is required" }, { status: 400 });

  const today = istToday();
  const rangeStart = addDays(today, -365);
  const supabase = createAdminClient();

  const buckets: LedgerBucket[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from("location_energy_readings")
      .select("ts, energy_delta_wh, cumulative_wh")
      .eq("location_id", id)
      .eq("device_id", deviceId)
      .gte("ts", `${rangeStart}T00:00:00+05:30`)
      .order("ts", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    buckets.push(...(data as LedgerBucket[]));
    if (data.length < PAGE) break;
  }

  // Holidays that apply everywhere (location_id null) or to this location.
  const { data: holidayRows, error: holidayError } = await supabase
    .from("public_holidays")
    .select("holiday_date, name")
    .or(`location_id.is.null,location_id.eq.${id}`)
    .gte("holiday_date", rangeStart)
    .order("holiday_date", { ascending: true });
  if (holidayError) return NextResponse.json({ error: holidayError.message }, { status: 500 });

  const holidays: HolidayEntry[] = (holidayRows ?? []).map((h) => ({ date: h.holiday_date, name: h.name }));
  const daily = aggregateDaily(buckets, holidays, today);
  const baselines = computeBaselines(daily, buckets, today);
  const primary = baselines[0];

  return NextResponse.json({
    data: {
      today,
      daily: daily.filter((d) => d.date >= primary.from),
      baselines,
      weekday_profile: weekdayProfile(daily, primary.from, primary.to),
      anomalies: findAnomalies(daily, primary),
      holidays: holidays.filter((h) => h.date >= primary.from),
      // Latest holiday on file — the UI warns when the calendar has run out.
      holiday_calendar_through: holidays.length ? holidays[holidays.length - 1].date : null,
    },
  });
}
