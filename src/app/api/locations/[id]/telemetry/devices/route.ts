import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { fetchOnegridDevices, OnegridApiError } from "@/lib/onegrid";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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

  try {
    const data = await fetchOnegridDevices(config.onegrid_api_key);
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof OnegridApiError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json({ error: "Failed to fetch devices" }, { status: 500 });
  }
}
