import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays, istDateOf } from "@/lib/energy-baseline";
import type { MidnightReadings } from "@/lib/energy-monthly";

const istMidnightIso = (date: string) => new Date(`${date}T00:00:00+05:30`).toISOString();
const CHUNK = 80;

/**
 * The meter's cumulative reading at IST midnight for the start of each date from `from` to
 * `to` inclusive, read from the local ledger only (never a live OneGrid call). Dates with no
 * stored row are simply absent, so a gap shows up as "unknown" and never as zero.
 */
export async function loadMidnightReadings(
  admin: SupabaseClient,
  args: { locationId: string; deviceId: string; from: string; to: string }
): Promise<MidnightReadings> {
  const dates: string[] = [];
  for (let d = args.from; d <= args.to; d = addDays(d, 1)) dates.push(d);
  const batches: string[][] = [];
  for (let i = 0; i < dates.length; i += CHUNK) batches.push(dates.slice(i, i + CHUNK));

  const results = await Promise.all(
    batches.map((batch) =>
      admin
        .from("location_energy_readings")
        .select("ts, cumulative_wh")
        .eq("location_id", args.locationId)
        .eq("device_id", args.deviceId)
        .in("ts", batch.map(istMidnightIso))
    )
  );
  const readings: MidnightReadings = new Map();
  for (const r of results) {
    if (r.error) throw new Error(r.error.message);
    for (const row of r.data ?? []) {
      if (row.cumulative_wh != null) readings.set(istDateOf(row.ts as string), Number(row.cumulative_wh));
    }
  }
  return readings;
}
