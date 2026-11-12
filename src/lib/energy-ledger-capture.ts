import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchOnegridDevices, fetchOnegridTelemetry, OnegridApiError } from "@/lib/onegrid";
import { recomputeDeltasFromCumulative } from "@/lib/energy-ledger";
import { describeOnegridError } from "@/lib/onegrid-errors";

// Scheduled counterpart to the headcount-triggered capture: extends each
// OneGrid-enabled location's ledger (location_energy_readings) from wherever it
// last stopped up to now, so a quiet week with no headcount logging no longer
// leaves a hole. Resuming from the ledger's own last row makes every run
// idempotent and self-healing — a missed run just means a bigger catch-up next
// time.

// Wide OneGrid ranges have been observed taking 30-45s+, so a long outage is
// worked off one 7-day chunk at a time rather than in a single request.
export const CAPTURE_CHUNK_DAYS = 7;
// A location/meter with nothing in the ledger starts here rather than at the
// beginning of time.
export const COLD_START_DAYS = 7;
// Empty chunks (an outage on OneGrid's side) are skipped within one run, but
// bounded so a long hole can't eat the whole time budget.
const MAX_CHUNKS_PER_RUN = 6;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CaptureResult {
  rowsUpserted: number;
  // Newest ts now stored for this meter after the run (null if nothing stored).
  through: string | null;
  // False while a catch-up is still working through a long gap.
  caughtUp: boolean;
  deviceId: string;
}

// OneGrid also returns a "latest reading" point at its true timestamp (e.g.
// 09:48:26) alongside the 15-minute buckets. That is provisional — the next
// on-grid bucket covers the same energy — so the scheduled capture stores only
// on-grid buckets, keeping the ledger at 96 rows/day.
function isOnGrid(ts: string): boolean {
  const d = new Date(ts);
  return d.getUTCMinutes() % 15 === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

// OneGrid reads a date-only `end` as IST midnight (exclusive).
function istDateOnly(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

interface CaptureInput {
  locationId: string;
  apiKey: string;
  defaultDeviceId: string | null;
  now?: Date;
}

export async function captureLocationLedger(
  supabase: SupabaseClient,
  { locationId, apiKey, defaultDeviceId, now = new Date() }: CaptureInput
): Promise<CaptureResult> {
  let deviceId = defaultDeviceId;
  if (!deviceId) {
    const devices = await fetchOnegridDevices(apiKey);
    const options = Object.values(devices.by_plant).flatMap((p) => p.devices);
    deviceId = (options.find((d) => d.meter_role === "main") ?? options[0])?.device_id ?? null;
  }
  if (!deviceId) throw new OnegridApiError(404, "NO_DEVICE", "No meter registered for this location");

  const { data: lastRow, error: lastErr } = await supabase
    .from("location_energy_readings")
    .select("ts, cumulative_wh")
    .eq("location_id", locationId)
    .eq("device_id", deviceId)
    .order("ts", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastErr) throw new Error(`ledger read failed: ${lastErr.message}`);

  let seed = lastRow ?? null;
  let cursor = seed ? new Date(seed.ts).getTime() : now.getTime() - COLD_START_DAYS * DAY_MS;
  let rowsUpserted = 0;
  let caughtUp = false;

  for (let chunk = 0; chunk < MAX_CHUNKS_PER_RUN; chunk++) {
    const remainingMs = now.getTime() - cursor;
    if (remainingMs <= 0) { caughtUp = true; break; }

    const lastChunk = remainingMs <= CAPTURE_CHUNK_DAYS * DAY_MS;
    const telemetry = await fetchOnegridTelemetry(apiKey, deviceId, {
      start: new Date(cursor).toISOString(),
      // Omitted on the final chunk so OneGrid runs through to "now".
      end: lastChunk ? undefined : istDateOnly(cursor + CAPTURE_CHUNK_DAYS * DAY_MS),
      every: "15m",
      derive: "delta",
      fields: "Energy_Consumption_Cumulative_Wh",
    });

    // Only rows newer than what's stored: re-sending the seed row itself would
    // recompute it against itself (zero elapsed) and null out a good delta.
    const seedMs = seed ? new Date(seed.ts).getTime() : -Infinity;
    const fresh = telemetry.series
      .filter((r) => r.ts && r.Energy_Consumption_Cumulative_Wh != null && isOnGrid(r.ts) && new Date(r.ts).getTime() > seedMs)
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

    if (fresh.length > 0) {
      const recomputed = recomputeDeltasFromCumulative(fresh, seed);
      const rows = recomputed.map((r) => ({
        location_id: locationId,
        device_id: deviceId,
        ts: new Date(r.ts).toISOString(),
        energy_delta_wh: r.energy_delta_wh,
        cumulative_wh: r.cumulative_wh,
      }));
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase
          .from("location_energy_readings")
          .upsert(rows.slice(i, i + 500), { onConflict: "location_id,device_id,ts" });
        if (error) throw new Error(`ledger write failed: ${error.message}`);
      }
      rowsUpserted += rows.length;
      const last = rows[rows.length - 1];
      seed = { ts: last.ts, cumulative_wh: last.cumulative_wh };
    }

    if (lastChunk) { caughtUp = true; break; }
    // Rows landed: the next run resumes from them. An empty chunk is a hole on
    // OneGrid's side — step over it and try the next one.
    if (fresh.length > 0) break;
    cursor += CAPTURE_CHUNK_DAYS * DAY_MS;
  }

  return { rowsUpserted, through: seed?.ts ?? null, caughtUp, deviceId };
}

export interface LocationCaptureSummary {
  location_id: string;
  status: "ok" | "error";
  rows_upserted: number;
  caught_up: boolean;
  // Plain classification only — never the raw OneGrid text, which can carry
  // their internal hostnames, and never the API key.
  error_kind?: string;
}

interface ConfigRow {
  location_id: string;
  onegrid_api_key: string | null;
  onegrid_default_device_id: string | null;
}

// Runs every OneGrid-enabled location in turn. One location failing (bad key,
// OneGrid down) never stops the others.
export async function captureAllLocations(
  supabase: SupabaseClient,
  { now = new Date(), budgetMs = 50_000 }: { now?: Date; budgetMs?: number } = {}
): Promise<{ locations: LocationCaptureSummary[]; skipped: number }> {
  const { data: configs, error } = await supabase
    .from("location_electricity_config")
    .select("location_id, onegrid_api_key, onegrid_default_device_id")
    .eq("onegrid_enabled", true)
    .not("onegrid_api_key", "is", null);
  if (error) throw new Error(`config read failed: ${error.message}`);

  const started = Date.now();
  const locations: LocationCaptureSummary[] = [];
  let skipped = 0;
  for (const cfg of (configs ?? []) as ConfigRow[]) {
    if (!cfg.onegrid_api_key) continue;
    if (Date.now() - started > budgetMs) { skipped++; continue; }
    try {
      const r = await captureLocationLedger(supabase, {
        locationId: cfg.location_id,
        apiKey: cfg.onegrid_api_key,
        defaultDeviceId: cfg.onegrid_default_device_id,
        now,
      });
      locations.push({ location_id: cfg.location_id, status: "ok", rows_upserted: r.rowsUpserted, caught_up: r.caughtUp });
    } catch (err) {
      const friendly = err instanceof OnegridApiError
        ? describeOnegridError({ status: err.status, code: err.code, message: err.message })
        : null;
      locations.push({
        location_id: cfg.location_id,
        status: "error",
        rows_upserted: 0,
        caught_up: false,
        error_kind: friendly?.kind ?? "internal",
      });
    }
  }
  return { locations, skipped };
}
