import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { addDays, istDateOf, istToday } from "@/lib/energy-baseline";
import { shiftMonth } from "@/lib/energy-monthly";

// Read-only monthly comparison input, from the local ledger (never a live OneGrid
// call). Returns the meter's cumulative reading at IST midnight for every day in
// the last 25 months, plus the latest reading — about one row per day instead of
// 96, so two years of history costs a handful of small requests rather than
// forty thousand rows. The page works out days, months and comparisons from it
// (see src/lib/energy-monthly.ts).
const MONTHS_BACK = 24; // current month + 24 = 25 months, so every visible month has a same-month-last-year
const CHUNK = 80;

const istMidnightIso = (date: string) => new Date(`${date}T00:00:00+05:30`).toISOString();

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
  const firstDate = `${shiftMonth(today.slice(0, 7), -MONTHS_BACK)}-01`;
  const dates: string[] = [];
  for (let d = firstDate; d <= today; d = addDays(d, 1)) dates.push(d);

  const supabase = createAdminClient();
  const readings: Record<string, number> = {};

  const batches: string[][] = [];
  for (let i = 0; i < dates.length; i += CHUNK) batches.push(dates.slice(i, i + CHUNK));

  const results = await Promise.all(
    batches.map((batch) =>
      supabase
        .from("location_energy_readings")
        .select("ts, cumulative_wh")
        .eq("location_id", id)
        .eq("device_id", deviceId)
        .in("ts", batch.map(istMidnightIso))
    )
  );
  for (const r of results) {
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
    for (const row of r.data ?? []) {
      if (row.cumulative_wh != null) readings[istDateOf(row.ts as string)] = Number(row.cumulative_wh);
    }
  }

  // Latest reading — stands in for "end of today" while today is still running.
  const { data: latestRow, error: latestError } = await supabase
    .from("location_energy_readings")
    .select("ts, cumulative_wh")
    .eq("location_id", id)
    .eq("device_id", deviceId)
    .not("cumulative_wh", "is", null)
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) return NextResponse.json({ error: latestError.message }, { status: 500 });

  return NextResponse.json({
    data: {
      today,
      readings,
      latest: latestRow ? { date: istDateOf(latestRow.ts as string), cumulative_wh: Number(latestRow.cumulative_wh) } : null,
    },
  });
}
