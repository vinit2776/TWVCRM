import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { phoneMatchClauses } from "@/lib/phone-search";
import { istDayKey } from "@/lib/lead-days";
import { FOLLOW_UP_GROUPS, groupFollowUps, soonestPerLead, type FollowUpGroup } from "@/lib/follow-up-groups";

const MAX_PENDING = 10000;
const MAX_OPEN_LEADS = 8000;
const CLOSED_STATUSES = "(won,lost,junk)";

// GET /api/leads/follow-ups?group=overdue|today|tomorrow|week|later|none&page=1&limit=50
//   &search=&status=&source=a,b&location_id=&assigned_to=&pinned=true
// The Leads → Follow-ups tab: a count for every pill, and the ids of the chosen group in the order
// it shows them, with each lead's due time and a count per date for the headers. The rows
// themselves come from GET /api/leads?view=ids&ids=…, so they carry everything a Leads row does.
// Only open leads count: not archived, and not won, lost or junk. Read-only.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const group = (searchParams.get("group") ?? "overdue") as FollowUpGroup;
  if (!FOLLOW_UP_GROUPS.includes(group)) return NextResponse.json({ error: "Unknown group" }, { status: 400 });
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50", 10) || 50));

  const status = searchParams.get("status");
  const sources = searchParams.get("source")?.split(",").filter(Boolean) ?? [];
  const search = searchParams.get("search")?.trim();
  const assignedTo = searchParams.get("assigned_to");
  const locationId = searchParams.get("location_id");
  const pinnedOnly = searchParams.get("pinned") === "true";
  if (assignedTo && assignedTo !== "none" && !/^[0-9a-f-]{36}$/i.test(assignedTo)) return NextResponse.json({ error: "Bad assigned_to" }, { status: 400 });
  if (locationId && !/^[0-9a-f-]{36}$/i.test(locationId)) return NextResponse.json({ error: "Bad location" }, { status: 400 });

  // The same text search the Leads list uses (name, email, phone, company).
  let searchOr = "";
  if (search && !search.startsWith("#")) {
    searchOr = `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%,mobile.ilike.%${search}%,company.ilike.%${search}%`;
    const phoneClauses = phoneMatchClauses(search, ["phone", "mobile"]);
    if (phoneClauses.length) searchOr += `,${phoneClauses.join(",")}`;
  }

  // Every pending follow-up on an open lead, narrowed by the page's filters.
  let pendingQuery = supabase
    .from("activities")
    .select("lead_id, follow_up_date, leads!inner(id)")
    .eq("is_follow_up_done", false)
    .not("follow_up_date", "is", null)
    .is("leads.archived_at", null)
    .not("leads.status", "in", CLOSED_STATUSES);
  // And every open lead, for the ones with nothing pending.
  let openQuery = supabase
    .from("leads")
    .select("id, created_at")
    .is("archived_at", null)
    .not("status", "in", CLOSED_STATUSES);

  if (status) {
    pendingQuery = pendingQuery.eq("leads.status", status);
    openQuery = openQuery.eq("status", status);
  }
  if (sources.length > 0) {
    pendingQuery = pendingQuery.in("leads.source", sources);
    openQuery = openQuery.in("source", sources);
  }
  if (pinnedOnly) {
    pendingQuery = pendingQuery.not("leads.pinned_at", "is", null);
    openQuery = openQuery.not("pinned_at", "is", null);
  }
  if (assignedTo) {
    pendingQuery = assignedTo === "none" ? pendingQuery.is("leads.assigned_to", null) : pendingQuery.eq("leads.assigned_to", assignedTo);
    openQuery = assignedTo === "none" ? openQuery.is("assigned_to", null) : openQuery.eq("assigned_to", assignedTo);
  }
  if (locationId) {
    pendingQuery = pendingQuery.eq("leads.location_id", locationId);
    openQuery = openQuery.eq("location_id", locationId);
  }
  if (searchOr) {
    pendingQuery = pendingQuery.or(searchOr, { referencedTable: "leads" });
    openQuery = openQuery.or(searchOr);
  }

  const [pendingRes, openRes] = await Promise.all([pendingQuery.limit(MAX_PENDING), openQuery.limit(MAX_OPEN_LEADS)]);
  if (pendingRes.error || openRes.error) {
    const e = pendingRes.error ?? openRes.error;
    console.error("[leads/follow-ups] load failed", e?.code, e?.message);
    return NextResponse.json({ error: "Could not load follow-ups" }, { status: 500 });
  }

  const nextDue = soonestPerLead((pendingRes.data ?? []) as unknown as { lead_id: string; follow_up_date: string }[]);
  const grouped = groupFollowUps(nextDue, (openRes.data ?? []) as { id: string; created_at: string }[]);

  const all = grouped.ids[group];
  const slice = all.slice((page - 1) * limit, page * limit);

  // Leads on each date, over the whole group, so a header can say "12 leads" while only 50 are loaded.
  const dateCounts: Record<string, number> = {};
  if (group !== "none") {
    for (const id of all) {
      const key = istDayKey(nextDue.get(id) as string);
      dateCounts[key] = (dateCounts[key] ?? 0) + 1;
    }
  }

  return NextResponse.json({
    counts: grouped.counts,
    group,
    ids: slice,
    due: Object.fromEntries(slice.filter((id) => nextDue.has(id)).map((id) => [id, nextDue.get(id)])),
    dateCounts,
    total: all.length,
    page,
    limit,
  });
}
