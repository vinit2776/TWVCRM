import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const locationId = request.nextUrl.searchParams.get("location_id");

  // Resolve location → lead IDs (same pattern as /api/dashboard)
  let locationLeadIds: string[] | null = null;
  if (locationId) {
    const { data: locationLeads } = await supabase
      .from("leads")
      .select("id")
      .eq("location_id", locationId);
    locationLeadIds = (locationLeads || []).map((l) => l.id);
  }

  let query = supabase
    .from("activities")
    .select(
      "id, follow_up_date, follow_up_notes, type, subject, lead_id, lead:leads!activities_lead_id_fkey(id, first_name, last_name)"
    )
    .eq("is_follow_up_done", false)
    .not("follow_up_date", "is", null);

  if (locationId) {
    if (locationLeadIds && locationLeadIds.length > 0) {
      query = query.in("lead_id", locationLeadIds);
    } else {
      // Location has no leads — return empty
      return NextResponse.json({ data: [] });
    }
  }

  query = query.order("follow_up_date", { ascending: true }).limit(25);

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: data ?? [] });
}
