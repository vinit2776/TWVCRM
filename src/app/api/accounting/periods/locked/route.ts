import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Locked accounting months ("YYYY-MM") from the last 12, for the usage-month picker to hide. */
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("accounting_periods")
    .select("year, month")
    .eq("status", "locked")
    .gte("year", new Date().getFullYear() - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const locked = (data ?? []).map((p) => `${p.year}-${String(p.month).padStart(2, "0")}`);
  return NextResponse.json({ locked });
}
