import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

// Reads from the local ledger (location_energy_readings) — not a live
// OneGrid call. Backing data comes from headcount-triggered backfill and
// the manual "Sync to local ledger" button, both server-side.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = request.nextUrl;
  const date = searchParams.get("date"); // YYYY-MM-DD, IST calendar day
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date (YYYY-MM-DD) is required" }, { status: 400 });
  }

  const start = `${date}T00:00:00+05:30`;
  const endDate = new Date(`${date}T00:00:00Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const end = `${endDate.toISOString().split("T")[0]}T00:00:00+05:30`;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("location_energy_readings")
    .select("ts, energy_delta_wh, cumulative_wh, device_id")
    .eq("location_id", id)
    .gte("ts", start)
    .lt("ts", end)
    .order("ts", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data });
}
