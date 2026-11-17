import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { LEAD_HANDLER_ROLES, LEAD_SOURCE_LABELS, WORKSPACE_TYPE_LABELS } from "@/lib/constants";
import { buildOverview, type OverviewLead, type RateLookup } from "@/lib/lead-overview";
import { requestThemes } from "@/lib/lead-value";
import { NON_EVENT_SUBJECTS } from "@/lib/lead-stale";

const MAX_LEADS = 6000;
const CHUNK = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

// GET /api/leads/overview?location=all|<uuid>&days=7|30|90
// The numbers behind Leads → Overview: what to act on now, what is on the table, and which
// locations, seat types and sources bring valuable customers. Read-only. A sales rep sees their
// own leads and unclaimed ones; admin and manager see everything.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !(LEAD_HANDLER_ROLES as readonly string[]).includes(me.role)) {
    return NextResponse.json({ error: "The overview is for admin, manager and sales roles" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const days = Number(searchParams.get("days") ?? "30");
  if (![7, 30, 90].includes(days)) return NextResponse.json({ error: "days must be 7, 30 or 90" }, { status: 400 });
  const loc = searchParams.get("location") ?? "all";
  if (loc !== "all" && !/^[0-9a-f-]{36}$/i.test(loc)) return NextResponse.json({ error: "location must be all or a location id" }, { status: 400 });

  const now = new Date();
  // Two windows of history for the comparison, plus every open lead however old (the working queue).
  const since = new Date(now.getTime() - days * 2 * DAY_MS).toISOString();

  const select =
    "id, lead_number, first_name, last_name, company, status, source, workspace_type, seat_capacity, budget_per_seat, location_id, assigned_to, created_at, archived_at, location:locations!leads_location_id_fkey(name), assigned_user:users!leads_assigned_to_fkey(full_name)";

  const recentQuery = supabase.from("leads").select(select).gte("created_at", since).order("created_at", { ascending: false }).limit(MAX_LEADS);
  const openQuery = supabase
    .from("leads")
    .select(select)
    .is("archived_at", null)
    .not("status", "in", "(won,lost,junk)")
    .lt("created_at", since)
    .limit(MAX_LEADS);
  const [recentRes, openRes] = await Promise.all([
    me.role === "sales_rep" ? recentQuery.or(`assigned_to.eq.${me.id},assigned_to.is.null`) : recentQuery,
    me.role === "sales_rep" ? openQuery.or(`assigned_to.eq.${me.id},assigned_to.is.null`) : openQuery,
  ]);
  if (recentRes.error || openRes.error) {
    const e = recentRes.error ?? openRes.error;
    console.error("[leads/overview] leads failed", e?.code, e?.message);
    return NextResponse.json({ error: e?.message ?? "Failed to load leads" }, { status: 500 });
  }
  const rows = [...((recentRes.data ?? []) as unknown as Row[]), ...((openRes.data ?? []) as unknown as Row[])];
  const ids = rows.map((r) => r.id as string);

  // First response, overdue follow-ups, and what people wrote (to group into themes).
  const firstResponse = new Map<string, string>();
  const overdue = new Map<string, number>();
  const texts = new Map<string, string[]>();
    for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const [acts, enqs] = await Promise.all([
      supabase
        .from("activities")
        .select("lead_id, created_at, subject, description, created_by, follow_up_date, is_follow_up_done")
        .in("lead_id", chunk)
        .limit(6000),
      supabase.from("lead_enquiries").select("lead_id, payload").in("lead_id", chunk).limit(3000),
    ]);
    if (acts.error || enqs.error) {
      const e = acts.error ?? enqs.error;
      console.error("[leads/overview] history failed", e?.code, e?.message);
      return NextResponse.json({ error: e?.message ?? "Failed to load history" }, { status: 500 });
    }
    for (const a of (acts.data ?? []) as Row[]) {
      const id = a.lead_id as string;
      const subject = (a.subject as string) ?? "";
      if (a.created_by && !(NON_EVENT_SUBJECTS as readonly string[]).includes(subject)) {
        const prev = firstResponse.get(id);
        if (!prev || Date.parse(a.created_at as string) < Date.parse(prev)) firstResponse.set(id, a.created_at as string);
      }
      if (!a.is_follow_up_done && a.follow_up_date && Date.parse(a.follow_up_date as string) < now.getTime()) {
        const d = Math.max(1, Math.floor((now.getTime() - Date.parse(a.follow_up_date as string)) / DAY_MS));
        overdue.set(id, Math.max(overdue.get(id) ?? 0, d));
      }
      const desc = (a.description as string) ?? "";
      const m = desc.match(/Other requests:\s*(.+)/);
      if (m) (texts.get(id) ?? texts.set(id, []).get(id)!).push(m[1]);
    }
    for (const e of (enqs.data ?? []) as Row[]) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const msg = [p.message, p.notes, p.requirements].filter((x): x is string => typeof x === "string").join(" ");
      if (msg) (texts.get(e.lead_id as string) ?? texts.set(e.lead_id as string, []).get(e.lead_id as string)!).push(msg);
    }
  }

  const leads: OverviewLead[] = rows.map((r) => ({
    id: r.id as string,
    leadNumber: r.lead_number as number,
    name: (r.company as string) || `${r.first_name as string} ${(r.last_name as string) ?? ""}`.trim(),
    company: (r.company as string) ?? null,
    status: r.status as string,
    source: r.source as string,
    workspaceType: (r.workspace_type as string) ?? null,
    seats: (r.seat_capacity as number) ?? null,
    budgetPerSeat: (r.budget_per_seat as number) ?? null,
    locationId: (r.location_id as string) ?? null,
    locationName: ((r.location as { name?: string } | null)?.name as string) ?? null,
    assignedTo: (r.assigned_to as string) ?? null,
    assigneeName: ((r.assigned_user as { full_name?: string } | null)?.full_name as string) ?? null,
    createdAt: r.created_at as string,
    archivedAt: (r.archived_at as string) ?? null,
    firstResponseAt: firstResponse.get(r.id as string) ?? null,
    overdueDays: overdue.get(r.id as string) ?? null,
    themes: requestThemes((texts.get(r.id as string) ?? []).join(" ")),
  }));

  // Rate card: a location's own rate wins over the all-locations default.
  const { data: rateRows } = await supabase.from("lead_rate_card").select("location_id, workspace_type, monthly_rate_per_seat");
  const rates = new Map<string, number>();
  for (const r of (rateRows ?? []) as Row[]) rates.set(`${(r.location_id as string) ?? "*"}|${r.workspace_type as string}`, Number(r.monthly_rate_per_seat));
  const rate: RateLookup = (locationId, type) => {
    if (!type) return null;
    return rates.get(`${locationId ?? "*"}|${type}`) ?? rates.get(`*|${type}`) ?? null;
  };
  // "Our rate" on the profile: the dedicated-desk rate for that location, else any rate it has.
  const locationId = loc === "all" ? null : loc;
  const ourRate = locationId
    ? (rate(locationId, "dedicated_desk") ?? [...rates.entries()].find(([k]) => k.startsWith(`${locationId}|`))?.[1] ?? null)
    : null;

  const { data: locationRows } = await supabase.from("locations").select("id, name").eq("is_active", true).order("name");

  const overview = buildOverview({
    leads,
    rate,
    now,
    windowDays: days,
    locationId,
    labelSource: (k) => LEAD_SOURCE_LABELS[k] ?? k,
    labelType: (k) => (k === "none" ? "Not given" : (WORKSPACE_TYPE_LABELS[k] ?? k.replace(/_/g, " "))),
    ourRate,
  });

  return NextResponse.json({
    data: overview,
    locations: locationRows ?? [],
    truncated: (recentRes.data?.length ?? 0) >= MAX_LEADS || (openRes.data?.length ?? 0) >= MAX_LEADS,
  });
}
