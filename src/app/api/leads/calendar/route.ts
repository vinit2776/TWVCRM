import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { istRange, type CalendarItem } from "@/lib/lead-calendar";
import { STALE_AFTER_DAYS, STALE_WARNING_DAYS, STALE_EXEMPT_STATUSES } from "@/lib/lead-stale";
import { loadStaleStates } from "@/lib/lead-stale-load";

const LIMIT = 500;

type LeadJoin = {
  id: string;
  first_name: string;
  last_name: string | null;
  company: string | null;
  assigned_to: string | null;
  pinned_at: string | null;
  assigned_user?: { full_name?: string | null } | null;
};

const leadName = (l: LeadJoin) => l.company || `${l.first_name} ${l.last_name ?? ""}`.trim();

// GET /api/leads/calendar?from=yyyy-MM-dd&to=yyyy-MM-dd&owner=me|all|<user id>[&overdue=true][&stale=true]
// What the sales team has on: follow-ups due in the range (and, optionally, everything overdue
// before it), the pinned leads, and per-day counts of enquiries received and actions done. A
// follow-up belongs to whoever handles the lead, so "owner" filters by the lead's handler.
// stale=true adds the leads that will be archived within STALE_WARNING_DAYS. Read-only.
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

  const { data: me } = await supabase.from("users").select("id").eq("auth_id", user.id).single();
  const ownerParam = searchParams.get("owner") ?? "me";
  if (!["all", "me"].includes(ownerParam) && !/^[0-9a-f-]{36}$/i.test(ownerParam)) {
    return NextResponse.json({ error: "owner must be me, all or a user id" }, { status: 400 });
  }
  const owner = ownerParam === "all" ? null : ownerParam === "me" ? (me?.id ?? null) : ownerParam;
  const { start, end } = istRange(from, to);

  const select =
    "id, type, subject, follow_up_date, follow_up_notes, meeting_start_at, lead_id, leads!inner(id, first_name, last_name, company, assigned_to, pinned_at, assigned_user:users!leads_assigned_to_fkey(full_name))";

  const dueQuery = () => {
    let q = supabase
      .from("activities")
      .select(select)
      .eq("is_follow_up_done", false)
      .not("follow_up_date", "is", null)
      .is("leads.archived_at", null);
    if (owner) q = q.eq("leads.assigned_to", owner);
    return q;
  };

  // Tours this person hosts or booked sit on their calendar too, even when someone else handles
  // the lead.
  const hostedQuery = owner
    ? supabase
        .from("activities")
        .select(select)
        .eq("type", "tour")
        .or(`tour_host_id.eq.${owner},created_by.eq.${owner}`)
        .gte("meeting_start_at", start)
        .lt("meeting_start_at", end)
        .is("leads.archived_at", null)
        .limit(200)
    : Promise.resolve({ data: [] as unknown[], error: null });

  const [dueRes, overdueRes, pinnedRes, enquiryRes, actionRes, hostedRes] = await Promise.all([
    dueQuery().gte("follow_up_date", start).lt("follow_up_date", end).order("follow_up_date").limit(LIMIT),
    searchParams.get("overdue") === "true"
      ? dueQuery().lt("follow_up_date", start).order("follow_up_date", { ascending: false }).limit(200)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    (() => {
      let q = supabase
        .from("leads")
        .select("id, first_name, last_name, company, assigned_to, pinned_at, assigned_user:users!leads_assigned_to_fkey(full_name)")
        .not("pinned_at", "is", null)
        .is("archived_at", null)
        .order("pinned_at", { ascending: false })
        .limit(100);
      if (owner) q = q.eq("assigned_to", owner);
      return q;
    })(),
    (() => {
      let q = supabase.from("lead_enquiries").select("received_at, leads!inner(assigned_to)").gte("received_at", start).lt("received_at", end).limit(2000);
      if (owner) q = q.eq("leads.assigned_to", owner);
      return q;
    })(),
    (() => {
      let q = supabase
        .from("activities")
        .select("created_at")
        .gte("created_at", start)
        .lt("created_at", end)
        .not("subject", "in", "(Claimed,Reassigned)")
        .limit(5000);
      if (owner) q = q.eq("created_by", owner);
      return q;
    })(),
    hostedQuery,
  ]);

  for (const r of [dueRes, overdueRes, pinnedRes, enquiryRes, actionRes, hostedRes]) {
    if (r.error) return NextResponse.json({ error: r.error.message }, { status: 500 });
  }

  // Leads that go stale within a few days: the same rule as the Leads list badge and the archive job.
  let staleSoon: { id: string; name: string; handler: string | null; daysLeft: number }[] = [];
  if (searchParams.get("stale") === "true") {
    const cutoff = new Date(Date.now() - (STALE_AFTER_DAYS - STALE_WARNING_DAYS) * 86_400_000).toISOString();
    let sq = supabase
      .from("leads")
      .select("id, status, created_at, first_name, last_name, company, assigned_to, pinned_at, assigned_user:users!leads_assigned_to_fkey(full_name)")
      .is("archived_at", null)
      .is("pinned_at", null)
      .not("status", "in", `(${STALE_EXEMPT_STATUSES.join(",")})`)
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(1000);
    if (owner) sq = sq.eq("assigned_to", owner);
    const { data: candidates, error: staleError } = await sq;
    if (staleError) return NextResponse.json({ error: staleError.message }, { status: 500 });
    const rows = (candidates ?? []) as unknown as (LeadJoin & { status: string; created_at: string })[];
    try {
      const states = await loadStaleStates(supabase, rows);
      staleSoon = rows
        .map((l) => ({ l, state: states.get(l.id) }))
        .flatMap(({ l, state }) =>
          state?.state === "warning"
            ? [{ id: l.id, name: leadName(l), handler: l.assigned_user?.full_name ?? null, daysLeft: state.daysLeft }]
            : [],
        )
        .sort((a, b) => a.daysLeft - b.daysLeft);
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "history failed" }, { status: 500 });
    }
  }

  type Row = {
    id: string;
    type: string;
    subject: string | null;
    follow_up_date: string;
    follow_up_notes: string | null;
    meeting_start_at?: string | null;
    leads: LeadJoin;
  };
  const toItem = (r: Row): CalendarItem => ({
    id: r.id,
    leadId: r.leads.id,
    leadName: leadName(r.leads),
    at: r.follow_up_date,
    what: r.follow_up_notes || r.subject || "Follow up",
    type: r.type,
    handler: r.leads.assigned_user?.full_name ?? null,
    pinned: !!r.leads.pinned_at,
  });

  return NextResponse.json({
    data: {
      followups: (() => {
        const due = ((dueRes.data ?? []) as unknown as Row[]).map(toItem);
        const seen = new Set(due.map((i) => i.id));
        const hosted = ((hostedRes.data ?? []) as unknown as Row[])
          .filter((r) => !seen.has(r.id))
          .map((r) => toItem({ ...r, follow_up_date: r.meeting_start_at ?? r.follow_up_date, follow_up_notes: r.follow_up_notes ?? "Tour" }));
        return [...due, ...hosted];
      })(),
      staleSoon,
      overdue: ((overdueRes.data ?? []) as unknown as Row[]).map(toItem),
      pinned: ((pinnedRes.data ?? []) as unknown as LeadJoin[]).map((l) => ({
        id: l.id,
        name: leadName(l),
        handler: l.assigned_user?.full_name ?? null,
      })),
      enquiryTimes: ((enquiryRes.data ?? []) as unknown as { received_at: string }[]).map((e) => e.received_at),
      actionTimes: ((actionRes.data ?? []) as unknown as { created_at: string }[]).map((a) => a.created_at),
    },
  });
}
