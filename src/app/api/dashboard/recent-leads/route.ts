import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/recent-leads?location_id=<uuid>
 * Returns the 10 most recently created leads with assigned user and last activity info.
 * Role-scoped: sales_rep/floor_manager see only their assigned leads.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const locationId = request.nextUrl.searchParams.get("location_id");

  // Build leads query
  let leadsQuery = supabase
    .from("leads")
    .select(
      "id, first_name, last_name, company, status, source, rating, created_at, assigned_to, assigned_user:users!leads_assigned_to_fkey(full_name)"
    )
    .order("created_at", { ascending: false })
    .limit(10);

  // Role-based scoping
  if (dbUser.role === "sales_rep" || dbUser.role === "floor_manager") {
    leadsQuery = leadsQuery.eq("assigned_to", dbUser.id);
  }

  // Location filter
  if (locationId) {
    leadsQuery = leadsQuery.eq("location_id", locationId);
  }

  const { data: leads, error } = await leadsQuery;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!leads || leads.length === 0) {
    return NextResponse.json({ data: [] });
  }

  // Fetch last activity per lead in one query
  const leadIds = leads.map((l) => l.id);
  const { data: activities } = await supabase
    .from("activities")
    .select(
      "lead_id, type, created_at, creator:users!activities_created_by_fkey(full_name)"
    )
    .in("lead_id", leadIds)
    .order("created_at", { ascending: false });

  // Build a map of lead_id → most recent activity
  const lastActivityMap: Record<
    string,
    { type: string; creator_name: string; created_at: string }
  > = {};
  for (const a of activities ?? []) {
    if (!lastActivityMap[a.lead_id]) {
      lastActivityMap[a.lead_id] = {
        type: a.type,
        creator_name: (a.creator as unknown as { full_name: string } | null)?.full_name ?? "",
        created_at: a.created_at,
      };
    }
  }

  const data = leads.map((lead) => ({
    id: lead.id,
    first_name: lead.first_name,
    last_name: lead.last_name,
    company: lead.company ?? null,
    status: lead.status,
    source: lead.source,
    rating: lead.rating,
    created_at: lead.created_at,
    assigned_user: (lead.assigned_user as unknown as { full_name: string } | null) ?? null,
    last_activity: lastActivityMap[lead.id] ?? null,
  }));

  return NextResponse.json({ data });
}
