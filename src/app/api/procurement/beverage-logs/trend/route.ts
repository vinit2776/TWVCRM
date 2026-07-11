import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const DAY_MS = 86400000;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const range = searchParams.get("range") === "month" ? "month" : "week";
  if (!locationId) return NextResponse.json({ error: "location_id is required" }, { status: 400 });

  const days = range === "month" ? 30 : 7;
  const since = new Date(Date.now() - (days - 1) * DAY_MS).toISOString().slice(0, 10);

  const { data: logs, error } = await supabase
    .from("beverage_logs")
    .select("logged_at, beverage_log_items(quantity)")
    .eq("location_id", locationId)
    .gte("logged_at", since);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const totalsByDay: Record<string, number> = {};
  for (const log of logs ?? []) {
    const day = new Date(log.logged_at).toISOString().slice(0, 10);
    const dayTotal = (log.beverage_log_items ?? []).reduce((s, it) => s + Number(it.quantity), 0);
    totalsByDay[day] = (totalsByDay[day] ?? 0) + dayTotal;
  }

  // Fill every day in the range (even zero-activity ones) for a continuous chart x-axis.
  const trend: { date: string; total: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    trend.push({ date, total: totalsByDay[date] ?? 0 });
  }

  return NextResponse.json({ trend, range, days });
}
