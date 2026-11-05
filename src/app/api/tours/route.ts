import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { tourBucket, tourStats, tourSortAscending, type TourBucket, type TourGroup, type TourOutcome } from "@/lib/tours";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TOURS = 3000;
const MAX_ROWS = 200;
const GROUPS: TourGroup[] = ["needs_update", "today", "tomorrow", "week", "later", "done"];
const CLOSED_LEAD_STATUSES = ["won", "lost", "junk"];

type LeadJoin = {
  id: string;
  lead_number: number;
  first_name: string;
  last_name: string | null;
  company: string | null;
  phone: string | null;
  mobile: string | null;
  status: string;
  archived_at: string | null;
  assigned_to: string | null;
  workspace_type: string | null;
  seat_capacity: number | null;
  lost_reason: string | null;
  location_id: string | null;
  location: { name: string } | null;
};

type TourRow = {
  id: string;
  lead_id: string;
  meeting_start_at: string;
  meeting_end_at: string | null;
  meeting_location: string | null;
  description: string | null;
  tour_outcome: TourOutcome | null;
  tour_outcome_at: string | null;
  tour_host_id: string | null;
  created_by: string | null;
  host: { full_name: string } | null;
  creator: { full_name: string } | null;
  lead: LeadJoin;
};

// GET /api/tours?group=needs_update|today|tomorrow|week|later|done&days=7|30|90&location_id=&host=
// The Leads → Tours tab: a count for every pill and the tours for the chosen one. Read-only. A sales
// rep sees tours on their own or unclaimed leads, or that they booked or host; admin and manager see all.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !(LEAD_HANDLER_ROLES as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "Tours are for admin, manager and sales roles" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const group = (searchParams.get("group") ?? "needs_update") as TourGroup;
  if (!GROUPS.includes(group)) return NextResponse.json({ error: "Unknown group" }, { status: 400 });
  const days = Number(searchParams.get("days") ?? "30");
  if (![7, 30, 90].includes(days)) return NextResponse.json({ error: "days must be 7, 30 or 90" }, { status: 400 });
  const locationFilter = searchParams.get("location_id");
  if (locationFilter && !/^[0-9a-f-]{36}$/i.test(locationFilter)) return NextResponse.json({ error: "Bad location" }, { status: 400 });
  const hostFilter = searchParams.get("host");
  if (hostFilter && hostFilter !== "none" && !/^[0-9a-f-]{36}$/i.test(hostFilter)) return NextResponse.json({ error: "Bad host" }, { status: 400 });

  const now = new Date();

  // The cut-off for asking about outcomes. Missing or unparseable: nothing is asked for.
  const { data: setting } = await createAdminClient()
    .from("app_settings")
    .select("value")
    .eq("key", "tour_outcome_effective_from")
    .maybeSingle();
  const parsed = setting?.value ? Date.parse(setting.value) : NaN;
  const cutoff = Number.isNaN(parsed) ? null : new Date(parsed);

  // Far enough back to catch every tour still waiting for an outcome, and the Done window.
  const doneSince = now.getTime() - days * DAY_MS;
  const since = new Date(cutoff ? Math.min(cutoff.getTime(), doneSince) : doneSince).toISOString();

  const { data, error } = await supabase
    .from("activities")
    .select(
      "id, lead_id, meeting_start_at, meeting_end_at, meeting_location, description, tour_outcome, tour_outcome_at, tour_host_id, created_by, host:users!activities_tour_host_id_fkey(full_name), creator:users!activities_created_by_fkey(full_name), lead:leads!activities_lead_id_fkey!inner(id, lead_number, first_name, last_name, company, phone, mobile, status, archived_at, assigned_to, workspace_type, seat_capacity, lost_reason, location_id, location:locations!leads_location_id_fkey(name))"
    )
    .eq("type", "tour")
    .not("meeting_start_at", "is", null)
    .gte("meeting_start_at", since)
    .order("meeting_start_at", { ascending: true })
    .limit(MAX_TOURS);
  if (error) {
    console.error("[tours] load failed", error.code, error.message);
    return NextResponse.json({ error: "Could not load tours" }, { status: 500 });
  }

  type Scored = { row: TourRow; bucket: TourBucket };
  const scored: Scored[] = [];
  for (const row of (data ?? []) as unknown as TourRow[]) {
    if (me.role === "sales_rep") {
      const mine = row.lead.assigned_to === me.id || row.lead.assigned_to === null || row.created_by === me.id || row.tour_host_id === me.id;
      if (!mine) continue;
    }
    const bucket = tourBucket(
      { start: row.meeting_start_at, end: row.meeting_end_at, outcome: row.tour_outcome, cutoff },
      now
    );
    // A tour on a closed or archived lead is no longer something to act on or prepare for.
    const live = bucket !== "done" && bucket !== "legacy";
    if (live && (row.lead.archived_at || CLOSED_LEAD_STATUSES.includes(row.lead.status))) continue;
    // Done and legacy tours only show inside the chosen window.
    if (!live && Date.parse(row.meeting_start_at) < doneSince) continue;
    scored.push({ row, bucket });
  }

  const inGroup = (b: TourBucket) => (group === "done" ? b === "done" || b === "legacy" : b === group);

  const counts: Record<TourGroup, number> = { needs_update: 0, today: 0, tomorrow: 0, week: 0, later: 0, done: 0 };
  for (const s of scored) counts[s.bucket === "legacy" ? "done" : (s.bucket as TourGroup)]++;

  // The tab's badge only needs the counts.
  if (searchParams.get("counts") === "1") return NextResponse.json({ counts });

  // Filters narrow the Done list and its numbers; the pills' counts stay whole.
  const filterOptions = { locations: new Map<string, string>(), hosts: new Map<string, string>() };
  let chosen = scored.filter((s) => inGroup(s.bucket));
  if (group === "done") {
    for (const s of chosen) {
      if (s.row.lead.location_id && s.row.lead.location) filterOptions.locations.set(s.row.lead.location_id, s.row.lead.location.name);
      if (s.row.tour_host_id && s.row.host) filterOptions.hosts.set(s.row.tour_host_id, s.row.host.full_name);
    }
    if (locationFilter) chosen = chosen.filter((s) => s.row.lead.location_id === locationFilter);
    if (hostFilter) chosen = chosen.filter((s) => (hostFilter === "none" ? !s.row.tour_host_id : s.row.tour_host_id === hostFilter));
  }

  chosen.sort((a, b) => {
    const d = Date.parse(a.row.meeting_start_at) - Date.parse(b.row.meeting_start_at);
    return tourSortAscending(group) ? d : -d;
  });
  const shown = chosen.slice(0, MAX_ROWS);

  // Each lead's next step now, so the row can say what happened after the tour.
  const leadIds = [...new Set(shown.map((s) => s.row.lead_id))];
  const nextByLead = new Map<string, { due_at: string; notes: string | null }>();
  if (leadIds.length > 0) {
    const { data: pending } = await supabase
      .from("activities")
      .select("lead_id, follow_up_date, follow_up_notes, subject, type")
      .in("lead_id", leadIds)
      .eq("is_follow_up_done", false)
      .not("follow_up_date", "is", null)
      .neq("type", "tour")
      .order("follow_up_date", { ascending: true })
      .limit(3000);
    for (const p of (pending ?? []) as { lead_id: string; follow_up_date: string; follow_up_notes: string | null; subject: string | null }[]) {
      if (!nextByLead.has(p.lead_id)) nextByLead.set(p.lead_id, { due_at: p.follow_up_date, notes: p.follow_up_notes || p.subject });
    }
  }

  const rows = shown.map(({ row, bucket }) => ({
    id: row.id,
    bucket,
    leadId: row.lead_id,
    leadNumber: row.lead.lead_number,
    name: row.lead.company || `${row.lead.first_name} ${row.lead.last_name ?? ""}`.trim(),
    phone: row.lead.mobile?.trim() || row.lead.phone?.trim() || null,
    leadStatus: row.lead.status,
    lostReason: row.lead.lost_reason,
    workspaceType: row.lead.workspace_type,
    seats: row.lead.seat_capacity,
    start: row.meeting_start_at,
    end: row.meeting_end_at,
    location: row.meeting_location || row.lead.location?.name || null,
    hostId: row.tour_host_id,
    hostName: row.host?.full_name ?? null,
    bookedBy: row.creator?.full_name ?? null,
    outcome: row.tour_outcome,
    outcomeAt: row.tour_outcome_at,
    note: row.description?.trim() || null,
    next: nextByLead.get(row.lead_id) ?? null,
  }));

  return NextResponse.json({
    counts,
    rows,
    total: chosen.length,
    stats: group === "done" ? tourStats(chosen.map((s) => ({ outcome: s.row.tour_outcome, leadStatus: s.row.lead.status }))) : null,
    filters:
      group === "done"
        ? {
            locations: [...filterOptions.locations].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
            hosts: [...filterOptions.hosts].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
          }
        : null,
  });
}
