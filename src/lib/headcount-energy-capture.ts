import { createAdminClient } from "@/lib/supabase/server";
import { fetchOnegridDevices, fetchOnegridTelemetry } from "@/lib/onegrid";

// Runs after a headcount row has already been saved and its response sent
// (via next/server's `after()`), so a slow or down OneGrid API never delays
// or fails the headcount save itself. Best-effort: any failure here just
// leaves the energy_* columns null on that row.
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

    const telemetry = await fetchOnegridTelemetry(config.onegrid_api_key, deviceId, {
      every: "15m",
      derive: "delta",
    });
    const series = telemetry.series;
    if (series.length === 0) return;

    const latest = series[series.length - 1];
    const todayWh = series.reduce((sum, r) => sum + (r.energy_delta_wh ?? 0), 0);

    await supabase
      .from("space_headcounts")
      .update({
        energy_reading_wh: latest.Energy_Consumption_Cumulative_Wh ?? null,
        energy_today_wh: todayWh,
        energy_device_id: deviceId,
        energy_captured_at: new Date().toISOString(),
      })
      .eq("id", headcountId);
  } catch {
    // Best-effort — a failed capture just leaves the energy_* columns null.
  }
}
