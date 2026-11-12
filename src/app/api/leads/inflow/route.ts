import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { summariseDays } from "@/lib/lead-days";

const IST_OFFSET_MS = 330 * 60 * 1000;
const MAX_ROWS = 5000;

// GET /api/leads/inflow?from=yyyy-MM-dd&to=yyyy-MM-dd[&source=..&location_id=..&assigned_to=..]
// How many leads came in on each IST day in the range, and from which source. Read-only; it backs
// the day headers on the Leads list so the counts cover the whole day, not just the loaded page.
// Archived leads are counted: a lead closed later still came in that day.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!isDay(from) || !isDay(to) || from > to) {
    return NextResponse.json({ error: "from and to must be yyyy-MM-dd days, from not after to" }, { status: 400 });
  }

  const start = new Date(new Date(`${from}T00:00:00Z`).getTime() - IST_OFFSET_MS).toISOString();
  const end = new Date(new Date(`${to}T00:00:00Z`).getTime() + 24 * 60 * 60 * 1000 - IST_OFFSET_MS).toISOString();

  let query = supabase.from("leads").select("created_at, source").gte("created_at", start).lt("created_at", end);

  const sources = searchParams.get("source")?.split(",").filter(Boolean) ?? [];
  if (sources.length > 0) query = query.in("source", sources);
  const locationId = searchParams.get("location_id");
  if (locationId) query = query.eq("location_id", locationId);
  const assignedTo = searchParams.get("assigned_to");
  if (assignedTo) query = assignedTo === "none" ? query.is("assigned_to", null) : query.eq("assigned_to", assignedTo);

  const { data, error } = await query.limit(MAX_ROWS);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: summariseDays((data ?? []) as { created_at: string; source: string }[]) });
}
