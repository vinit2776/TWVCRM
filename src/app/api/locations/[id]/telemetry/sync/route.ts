import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { fetchOnegridDevices, fetchOnegridTelemetry } from "@/lib/onegrid";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

// Manual, user-triggered backfill into location_energy_readings for an
// older period than the headcount-triggered capture reaches (that one caps
// at 96h to stay fast and best-effort — see src/lib/headcount-energy-capture.ts).
// No cron: an admin picks a range and this fills it, chunked and resumable so
// a long historical pull doesn't get lost to the function's time limit.
export const maxDuration = 60;

const bodySchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "start must be YYYY-MM-DD"),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "end must be YYYY-MM-DD"),
});

const CHUNK_DAYS = 30;
const TIME_BUDGET_MS = 50_000; // leave buffer under the 60s function cap

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });
  if (!["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Admin or Manager role required" }, { status: 403 });
  }

  const body = await request.json();
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const { start, end } = parsed.data;
  if (start > end) {
    return NextResponse.json({ error: "start must be on or before end" }, { status: 400 });
  }

  const { data: config } = await supabase
    .from("location_electricity_config")
    .select("onegrid_enabled, onegrid_api_key, onegrid_default_device_id")
    .eq("location_id", id)
    .maybeSingle();
  if (!config?.onegrid_enabled || !config.onegrid_api_key) {
    return NextResponse.json({ error: "OneGrid telemetry is not configured for this location" }, { status: 400 });
  }

  let deviceId = config.onegrid_default_device_id ?? null;
  if (!deviceId) {
    try {
      const devices = await fetchOnegridDevices(config.onegrid_api_key);
      const options = Object.values(devices.by_plant).flatMap((p) => p.devices);
      deviceId = (options.find((d) => d.meter_role === "main") ?? options[0])?.device_id ?? null;
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to resolve meter" }, { status: 502 });
    }
  }
  if (!deviceId) return NextResponse.json({ error: "No meter registered for this location" }, { status: 400 });

  const startedAt = Date.now();
  let cursor = new Date(`${start}T00:00:00Z`);
  const rangeEnd = new Date(`${end}T00:00:00Z`);
  rangeEnd.setUTCDate(rangeEnd.getUTCDate() + 1); // end date is inclusive

  const totalDays = Math.ceil((rangeEnd.getTime() - cursor.getTime()) / 86_400_000);
  const chunksTotal = Math.max(1, Math.ceil(totalDays / CHUNK_DAYS));

  let rowsUpserted = 0;
  let chunksProcessed = 0;
  let complete = true;
  let syncedThrough = start;
  const chunkErrors: string[] = [];

  while (cursor < rangeEnd) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { complete = false; break; }

    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_DAYS);
    const clampedEnd = chunkEnd > rangeEnd ? rangeEnd : chunkEnd;

    try {
      const telemetry = await fetchOnegridTelemetry(config.onegrid_api_key, deviceId, {
        start: cursor.toISOString().split("T")[0],
        end: clampedEnd.toISOString().split("T")[0],
        every: "15m",
        derive: "delta",
        fields: "Energy_Consumption_Cumulative_Wh",
      });
      const rows = telemetry.series
        .filter((r) => r.ts)
        .map((r) => ({
          location_id: id,
          device_id: deviceId,
          ts: new Date(r.ts).toISOString(),
          energy_delta_wh: r.energy_delta_wh ?? null,
          cumulative_wh: r.Energy_Consumption_Cumulative_Wh ?? null,
        }));
      if (rows.length > 0) {
        const { error: upsertError } = await supabase
          .from("location_energy_readings")
          .upsert(rows, { onConflict: "location_id,device_id,ts" });
        if (upsertError) throw new Error(upsertError.message);
        rowsUpserted += rows.length;
      }
      syncedThrough = clampedEnd.toISOString().split("T")[0];
    } catch (err) {
      complete = false;
      chunkErrors.push(err instanceof Error ? err.message : "Unknown error");
      break; // stop at the first failing chunk rather than skipping ahead over a gap
    }

    chunksProcessed++;
    cursor = clampedEnd;
  }

  await logAudit(supabase, {
    entityType: "location_energy_sync",
    entityId: id,
    action: "sync",
    performedBy: dbUser.id,
    changes: {
      range: { old: null, new: `${start} to ${end}` },
      rows_upserted: { old: null, new: rowsUpserted },
      complete: { old: null, new: complete },
    },
  });

  return NextResponse.json({
    data: {
      rows_upserted: rowsUpserted,
      chunks_processed: chunksProcessed,
      chunks_total: chunksTotal,
      synced_through: syncedThrough,
      complete,
      errors: chunkErrors,
    },
  });
}
