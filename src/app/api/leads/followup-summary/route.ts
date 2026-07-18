import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Lightweight, unfiltered counts of leads with a pending overdue/due-today follow-up —
// powers the "N overdue follow-ups" banner on the Leads list so it's visible regardless
// of whatever status/source/location filters are currently applied to the table below it.
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("activities")
    .select("lead_id, follow_up_date, leads!inner(archived_at)")
    .eq("is_follow_up_done", false)
    .not("follow_up_date", "is", null)
    .lte("follow_up_date", `${today}T23:59:59.999`)
    .is("leads.archived_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const overdueLeadIds = new Set<string>();
  const dueTodayLeadIds = new Set<string>();
  for (const row of (data || []) as { lead_id: string; follow_up_date: string }[]) {
    const d = row.follow_up_date.slice(0, 10);
    if (d < today) overdueLeadIds.add(row.lead_id);
    else dueTodayLeadIds.add(row.lead_id);
  }
  // A lead can carry both an overdue and a due-today pending activity — count the lead once,
  // in the more urgent bucket.
  for (const id of overdueLeadIds) dueTodayLeadIds.delete(id);

  return NextResponse.json({ overdue: overdueLeadIds.size, due_today: dueTodayLeadIds.size });
}
