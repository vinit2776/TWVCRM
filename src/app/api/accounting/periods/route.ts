import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const year = parseInt(searchParams.get("year") || String(new Date().getFullYear()));
  const month = parseInt(searchParams.get("month") || String(new Date().getMonth() + 1));

  if (month < 1 || month > 12) {
    return NextResponse.json({ error: "Invalid month" }, { status: 400 });
  }

  // Try to fetch existing period
  let { data: period } = await supabase
    .from("accounting_periods")
    .select("*, locker:users!accounting_periods_locked_by_fkey(id, full_name)")
    .eq("year", year)
    .eq("month", month)
    .single();

  // Auto-create if not found
  if (!period) {
    const { data: newPeriod, error: insertError } = await supabase
      .from("accounting_periods")
      .insert({ year, month, status: "open" })
      .select("*, locker:users!accounting_periods_locked_by_fkey(id, full_name)")
      .single();

    if (insertError) {
      // Race condition: another request created it, fetch again
      const { data: retryPeriod } = await supabase
        .from("accounting_periods")
        .select("*, locker:users!accounting_periods_locked_by_fkey(id, full_name)")
        .eq("year", year)
        .eq("month", month)
        .single();
      period = retryPeriod;
    } else {
      period = newPeriod;
    }
  }

  if (!period) {
    return NextResponse.json({ error: "Failed to get or create accounting period" }, { status: 500 });
  }

  return NextResponse.json({ data: period });
}
