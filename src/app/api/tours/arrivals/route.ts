import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { istDayKey } from "@/lib/lead-days";
import { arrivalState, type ArrivalState } from "@/lib/tour-reports";

const MAX_ROWS = 60;

// GET /api/tours/arrivals
// Today's tours (and any earlier tour whose customer arrived but has no report yet), with where each
// stands: upcoming, here now, reported, or did not come. A floor incharge sees tours at their own
// centres or that they host or accompany; a sales rep their own; admin and manager all. Read-only.
export async function GET(_request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !([...LEAD_HANDLER_ROLES, "floor_manager"] as readonly string[]).includes(me.role)) {
    return NextResponse.json({ data: [] });
  }

  const admin = createAdminClient();
  let centreIds: string[] = [];
  if (me.role === "floor_manager") {
    const { data: centres } = await admin.from("locations").select("id").or(`incharge_user_id_1.eq.${me.id},incharge_user_id_2.eq.${me.id}`);
    centreIds = (centres ?? []).map((c) => c.id as string);
  }

  const now = new Date();
  const dayStart = new Date(`${istDayKey(now)}T00:00:00+05:30`).toISOString();
  const dayEnd = new Date(Date.parse(dayStart) + 24 * 60 * 60 * 1000).toISOString();
  const select =
    "id, lead_id, meeting_start_at, meeting_location, tour_outcome, tour_host_id, accompanier_id, arrived_at, created_by, " +
    "host:users!activities_tour_host_id_fkey(full_name), accompanier:users!activities_accompanier_id_fkey(full_name), creator:users!activities_created_by_fkey(full_name), " +
    "lead:leads!activities_lead_id_fkey!inner(id, first_name, last_name, company, status, archived_at, assigned_to, location_id, workspace_type, seat_capacity, start_date, quoted_per_seat, extras, location:locations!leads_location_id_fkey(name))";
  const [todayRes, waitingRes] = await Promise.all([
    supabase.from("activities").select(select).eq("type", "tour").gte("meeting_start_at", dayStart).lt("meeting_start_at", dayEnd).order("meeting_start_at", { ascending: true }).limit(200),
    // Arrived on an earlier day and still no report: it stays until the report is in.
    supabase.from("activities").select(select).eq("type", "tour").lt("meeting_start_at", dayStart).not("arrived_at", "is", null).is("tour_outcome", null).limit(50),
  ]);
  if (todayRes.error || waitingRes.error) {
    console.error("[tours/arrivals] load failed", todayRes.error?.code ?? waitingRes.error?.code);
    return NextResponse.json({ error: "Could not load arrivals" }, { status: 500 });
  }

  type Row = {
    id: string; lead_id: string; meeting_start_at: string; meeting_location: string | null; tour_outcome: string | null;
    tour_host_id: string | null; accompanier_id: string | null; arrived_at: string | null; created_by: string | null;
    host: { full_name: string } | null; accompanier: { full_name: string } | null; creator: { full_name: string } | null;
    lead: { id: string; first_name: string; last_name: string | null; company: string | null; status: string; archived_at: string | null; assigned_to: string | null; location_id: string | null; workspace_type: string | null; seat_capacity: number | null; start_date: string | null; quoted_per_seat: number | null; extras: string[] | null; location: { name: string } | null };
  };
  const rows = [...((todayRes.data ?? []) as unknown as Row[]), ...((waitingRes.data ?? []) as unknown as Row[])];

  // Which of these already have a report.
  const { data: reports } = rows.length ? await admin.from("tour_reports").select("activity_id").in("activity_id", rows.map((r) => r.id)) : { data: [] };
  const reported = new Set((reports ?? []).map((r) => r.activity_id as string));

  const out = rows
    .filter((r) => {
      if (r.lead.archived_at) return false;
      if (me.role === "sales_rep") return r.lead.assigned_to === me.id || r.lead.assigned_to === null || r.created_by === me.id || r.tour_host_id === me.id;
      if (me.role === "floor_manager") {
        return (r.lead.location_id !== null && centreIds.includes(r.lead.location_id)) || r.tour_host_id === me.id || r.accompanier_id === me.id;
      }
      return true;
    })
    .map((r) => ({
      id: r.id,
      leadId: r.lead_id,
      name: r.lead.company || `${r.lead.first_name} ${r.lead.last_name === "-" ? "" : (r.lead.last_name ?? "")}`.trim(),
      start: r.meeting_start_at,
      location: r.meeting_location || r.lead.location?.name || null,
      hostName: r.host?.full_name ?? null,
      accompanierId: r.accompanier_id,
      accompanierName: r.accompanier?.full_name ?? null,
      bookedBy: r.creator?.full_name ?? null,
      arrivedAt: r.arrived_at,
      state: arrivalState({ outcome: r.tour_outcome, arrivedAt: r.arrived_at, hasReport: reported.has(r.id) }) as ArrivalState,
      workspaceType: r.lead.workspace_type,
      seats: r.lead.seat_capacity,
      startDate: r.lead.start_date,
      quotedPerSeat: r.lead.quoted_per_seat,
      extras: r.lead.extras ?? [],
    }))
    .slice(0, MAX_ROWS);

  return NextResponse.json({ data: out });
}
