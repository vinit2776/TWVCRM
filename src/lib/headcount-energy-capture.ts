import { createAdminClient } from "@/lib/supabase/server";
import { fetchOnegridDevices, fetchOnegridTelemetry } from "@/lib/onegrid";
import { recomputeDeltasFromCumulative } from "@/lib/energy-ledger";

// Cold-start / big-gap cap: if this location+device has never been captured
// before, or the gap since its last row is large, don't ask OneGrid for the
// whole gap — wide ranges containing real data have been directly observed
// taking 30-45s+ (or timing out), which is too long for a best-effort
// background task. A location with no headcount activity for longer than
// this just keeps a gap in its ledger rather than risking the capture.
// 96h (4 days) rather than a tighter window to give slightly more slack for
// data to actually land on OneGrid's side before being asked for.
const MAX_BACKFILL_HOURS = 96;

function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // en-CA -> YYYY-MM-DD
}

// Runs after a headcount row has already been saved and its response sent
// (via next/server's `after()`), so a slow or down OneGrid API never delays
// or fails the headcount save itself. Best-effort: any failure here just
// leaves the energy_* columns null on that row, and the ledger simply isn't
// extended this time — the next headcount save picks up wherever the ledger
// last left off.
export async function captureHeadcountEnergy(headcountId: string, locationId: string) {
  try {
    const supabase = createAdminClient();

    const { data: config } = await supabase
      .from("location_electricity_config")
      .select("onegrid_enabled, onegrid_api_key, onegrid_default_device_id")
      .eq("location_id", locationId)
      .maybeSingle();

    if (!config?.onegrid_enabled || !config.onegrid_api_key) return;

    let deviceId = config.onegrid_default_device_id ?? null;
    if (!deviceId) {
      const devices = await fetchOnegridDevices(config.onegrid_api_key);
      const options = Object.values(devices.by_plant).flatMap((p) => p.devices);
      deviceId = (options.find((d) => d.meter_role === "main") ?? options[0])?.device_id ?? null;
    }
    if (!deviceId) return;

    // Resume from this location+device's own ledger, capped so a long-dormant
    // location doesn't trigger a slow wide-range OneGrid query.
    const { data: lastRow } = await supabase
      .from("location_energy_readings")
      .select("ts, cumulative_wh")
      .eq("location_id", locationId)
      .eq("device_id", deviceId)
      .order("ts", { ascending: false })
      .limit(1)
      .maybeSingle();

    const cap = new Date(Date.now() - MAX_BACKFILL_HOURS * 60 * 60 * 1000);
    const lastFilled = lastRow?.ts ? new Date(lastRow.ts) : null;
    const start = lastFilled && lastFilled > cap ? lastFilled : cap;

    // One call covers both jobs: extends the ledger for whatever gap exists,
    // and its own latest bucket is the same "freshest available reading"
    // the headcount row's own snapshot wants — no second, redundant fetch.
    const telemetry = await fetchOnegridTelemetry(config.onegrid_api_key, deviceId, {
      start: start.toISOString(),
      every: "15m",
      derive: "delta",
      fields: "Energy_Consumption_Cumulative_Wh",
    });
    const series = telemetry.series.filter((r) => r.ts);
    if (series.length === 0) return;

    const recomputed = recomputeDeltasFromCumulative(series, lastRow ?? null);

    const ledgerRows = recomputed.map((r) => ({
      location_id: locationId,
      device_id: deviceId,
      ts: new Date(r.ts).toISOString(),
      energy_delta_wh: r.energy_delta_wh,
      cumulative_wh: r.cumulative_wh,
    }));
    if (ledgerRows.length > 0) {
      await supabase
        .from("location_energy_readings")
        .upsert(ledgerRows, { onConflict: "location_id,device_id,ts" });
    }

    const today = todayIST();
    const todaysRows = recomputed.filter((r) => String(r.ts).slice(0, 10) === today);
    const latest = recomputed[recomputed.length - 1];
    const todayWh = todaysRows.reduce((sum, r) => sum + (r.energy_delta_wh ?? 0), 0);

    await supabase
      .from("space_headcounts")
      .update({
        energy_reading_wh: latest.cumulative_wh,
        energy_today_wh: todayWh,
        energy_device_id: deviceId,
        energy_captured_at: new Date().toISOString(),
      })
      .eq("id", headcountId);
  } catch {
    // Best-effort — a failed capture just leaves the energy_* columns null
    // and the ledger un-extended; the next headcount save retries the gap.
  }
}
