import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { addDays, istToday, type HolidayEntry, type LedgerBucket } from "@/lib/energy-baseline";
import { dailyPeaks, dayCurve } from "@/lib/energy-peak";

// Read-only peak-demand view over the local 15-minute ledger — never a live
// OneGrid call, so it works for any day already synced.
//   ?device_id=…&days=30            → per-day peak summaries for the last N days (+28 days of lookback)
//   ?device_id=…&view=day&date=…    → that day's 96-slot demand curve (kW)
const PAGE = 1000; // PostgREST's default max rows per request
const MAX_PAGES = 14; // 14k rows ≈ 145 days of one meter — hard stop against runaway loops
// Extra history returned beyond the requested range, so a Sunday or holiday can
// be compared with its own kind (see peakVsPrior) even on the 14-day view.
const COMPARE_LOOKBACK_DAYS = 28;
const ALLOWED_DAYS = [14, 30, 90];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  // One meter at a time: summing several meters (e.g. main + sub) would double count.
  const deviceId = sp.get("device_id");
  if (!deviceId) return NextResponse.json({ error: "device_id is required" }, { status: 400 });

  const today = istToday();
  const supabase = createAdminClient();

  async function loadRows(fromDate: string, toDate: string): Promise<LedgerBucket[] | { error: string }> {
    const rows: LedgerBucket[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await supabase
        .from("location_energy_readings")
        .select("ts, energy_delta_wh, cumulative_wh")
        .eq("location_id", id)
        .eq("device_id", deviceId!)
        .gte("ts", `${fromDate}T00:00:00+05:30`)
        // Through the reading stamped midnight, which closes the day's last slot.
        .lte("ts", `${addDays(toDate, 1)}T00:00:00+05:30`)
        .order("ts", { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) return { error: error.message };
      rows.push(...(data as LedgerBucket[]));
      if (data.length < PAGE) break;
    }
    return rows;
  }

  if (sp.get("view") === "day") {
    const date = sp.get("date");
    if (!date || !DATE_RE.test(date) || date > today) {
      return NextResponse.json({ error: "date (YYYY-MM-DD, not in the future) is required" }, { status: 400 });
    }
    // One extra day before, so slot 0 has the reading 15 minutes earlier to difference against.
    const rows = await loadRows(addDays(date, -1), date);
    if ("error" in rows) return NextResponse.json({ error: rows.error }, { status: 500 });
    return NextResponse.json({ data: { date, kw: dayCurve(rows, date) } });
  }

  const daysParam = parseInt(sp.get("days") ?? "30", 10);
  const days = ALLOWED_DAYS.includes(daysParam) ? daysParam : 30;
  const loadFrom = addDays(today, -(days - 1) - COMPARE_LOOKBACK_DAYS);
  const rows = await loadRows(addDays(loadFrom, -1), today);
  if ("error" in rows) return NextResponse.json({ error: rows.error }, { status: 500 });

  const { data: holidayRows, error: holidayError } = await supabase
    .from("public_holidays")
    .select("holiday_date, name")
    .or(`location_id.is.null,location_id.eq.${id}`)
    .gte("holiday_date", loadFrom);
  if (holidayError) return NextResponse.json({ error: holidayError.message }, { status: 500 });
  const holidays: HolidayEntry[] = (holidayRows ?? []).map((h) => ({ date: h.holiday_date, name: h.name }));

  return NextResponse.json({ data: { today, days, daily: dailyPeaks(rows, holidays, today, loadFrom, today) } });
}
