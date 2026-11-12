import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { fetchOnegridTelemetry, OnegridApiError } from "@/lib/onegrid";

const FORWARDED_PARAMS = [
  "date", "start", "end", "hour", "minute", "fields",
  "every", "agg", "format", "derive", "measurement",
] as const;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; deviceId: string }> }
) {
  const { id, deviceId } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();
  const { data: config } = await supabase
    .from("location_electricity_config")
    .select("onegrid_enabled, onegrid_api_key")
    .eq("location_id", id)
    .maybeSingle();

  if (!config?.onegrid_enabled || !config.onegrid_api_key) {
    return NextResponse.json(
      { error: "OneGrid telemetry is not configured for this location" },
      { status: 400 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const forwarded: Record<string, string | undefined> = {};
  for (const key of FORWARDED_PARAMS) {
    forwarded[key] = searchParams.get(key) ?? undefined;
  }

  try {
    const data = await fetchOnegridTelemetry(config.onegrid_api_key, deviceId, forwarded);
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof OnegridApiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to fetch telemetry" }, { status: 500 });
  }
}
