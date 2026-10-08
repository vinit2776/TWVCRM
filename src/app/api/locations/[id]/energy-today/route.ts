import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { addDays, istToday, type HolidayEntry, type LedgerBucket } from "@/lib/energy-baseline";
import { buildTodayComparison, BASELINE_DAYS } from "@/lib/energy-today";

// Read-only: today's usage vs the typical curve for the same kind of day, from
// the local ledger (never a live OneGrid call). Loads only the last ~5 weeks, so
// the chart can refresh every 15 minutes without the 365-day cost of energy-trends.
const PAGE = 1000; // PostgREST's default max rows per request
const MAX_PAGES = 12; // 12k rows ≈ 125 days of one meter — hard stop against runaway loops

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // One meter at a time: summing several meters would double count.
  const deviceId = request.nextUrl.searchParams.get("device_id");
  if (!deviceId) return NextResponse.json({ error: "device_id is required" }, { status: 400 });

  const now = new Date();
  // One extra day before the baseline window so its first day has a prior reading.
  const rangeStart = addDays(istToday(now), -(BASELINE_DAYS + 5));
  const supabase = createAdminClient();

  const rows: LedgerBucket[] = [];
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
    rows.push(...(data as LedgerBucket[]));
    if (data.length < PAGE) break;
  }

  const { data: holidayRows, error: holidayError } = await supabase
    .from("public_holidays")
    .select("holiday_date, name")
    .or(`location_id.is.null,location_id.eq.${id}`)
    .gte("holiday_date", rangeStart);
  if (holidayError) return NextResponse.json({ error: holidayError.message }, { status: 500 });

  const holidays: HolidayEntry[] = (holidayRows ?? []).map((h) => ({ date: h.holiday_date, name: h.name }));
  return NextResponse.json({ data: buildTodayComparison(rows, holidays, now) });
}
