import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { ENQUIRY_SELECT, type RawEnquiryRow } from "@/lib/enquiries";
import { ENQUIRY_VIEWER_ROLE } from "@/lib/restricted-roles";
import { loadEnquiryProgress } from "@/lib/enquiry-progress-load";

// GET /api/leads/enquiry-log — one row per public-form enquiry (lead_enquiries).
//   ?source=google_ads|meta_ads|direct_walkin|whatsapp
//   &outcome=unresolved|converted|not_interested|no_response|superseded|spam
//   (spam enquiries are hidden unless outcome=spam is asked for)
//   &from=ISO-date   — an enquiry matches if it was received, or resolved, on/after this
//   &include_unresolved=true — also return every unresolved enquiry regardless of age
//   &to=ISO-date     — received on/before this
//   &location_id=UUID (the lead's location)
//   &limit=200 (default 200, max 500)
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = request.nextUrl.searchParams;
  const source = sp.get("source");
  const outcome = sp.get("outcome");
  const from = sp.get("from");
  const to = sp.get("to");
  const locationId = sp.get("location_id");
  const includeUnresolved = sp.get("include_unresolved") === "true";
  const limit = Math.min(parseInt(sp.get("limit") || "200", 10), 500);

  // Filtering on the lead's location needs an inner join so non-matching enquiries drop out.
  const select = locationId
    ? ENQUIRY_SELECT.replace("lead:leads!lead_enquiries_lead_id_fkey(", "lead:leads!lead_enquiries_lead_id_fkey!inner(")
    : ENQUIRY_SELECT;

  let query = supabase
    .from("lead_enquiries")
    .select(select)
    .order("received_at", { ascending: false })
    .limit(limit);

  if (source) query = query.eq("source", source);
  if (locationId) query = query.eq("lead.location_id", locationId);
  if (from) {
    const parts = [`received_at.gte.${from}`, `resolved_at.gte.${from}`];
    if (includeUnresolved) parts.push("resolved_at.is.null");
    query = query.or(parts.join(","));
  }
  if (to) query = query.lte("received_at", to);

  if (outcome === "unresolved") query = query.is("resolved_at", null);
  else if (outcome) query = query.eq("resolution_outcome", outcome);
  // A plain `neq` would also drop rows whose outcome is NULL, i.e. every open enquiry.
  if (outcome !== "spam") query = query.or("resolution_outcome.is.null,resolution_outcome.neq.spam");

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // How many are stashed as spam (same source / date window), so the page can say so.
  let spamQuery = supabase
    .from("lead_enquiries")
    .select("id", { count: "exact", head: true })
    .eq("resolution_outcome", "spam");
  if (source) spamQuery = spamQuery.eq("source", source);
  if (from) spamQuery = spamQuery.gte("received_at", from);
  if (to) spamQuery = spamQuery.lte("received_at", to);
  const { count: spamCount } = await spamQuery;

  // Roll up counts in the same response so the page can show summary tiles without a second
  // round trip. `superseded` is history with no recorded outcome, so it stays out of the
  // outcome figures.
  type Row = { resolved_at: string | null; resolution_outcome: string | null };
  const summary = (data as unknown as Row[]).reduce(
    (acc, row) => {
      acc.total += 1;
      if (!row.resolved_at) acc.unresolved += 1;
      else if (row.resolution_outcome === "converted") acc.converted += 1;
      else if (row.resolution_outcome === "not_interested") acc.notInterested += 1;
      else if (row.resolution_outcome === "no_response") acc.noResponse += 1;
      else if (row.resolution_outcome === "superseded") acc.superseded += 1;
      return acc;
    },
    { total: 0, unresolved: 0, converted: 0, notInterested: 0, noResponse: 0, superseded: 0 }
  );

  // An enquiry_viewer (e.g. the social media manager) follows enquiry activity, not the
  // customers: strip contact details here so they never reach that browser.
  const { data: me } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  const viewer = me?.role === ENQUIRY_VIEWER_ROLE;

  // Stage comes from the lead's proposals and contracts, so it is worked out here (and left
  // off for the read-only viewer, who sees no customer detail).
  let stages = new Map<string, { stage: { key: string; label: string } }>();
  if (!viewer) {
    try {
      const leadIds = (data as unknown as { lead_id: string | null }[]).map((r) => r.lead_id).filter((x): x is string => !!x);
      stages = await loadEnquiryProgress(createAdminClient(), leadIds);
    } catch (err) {
      console.error("[enquiry-log] stage lookup failed:", err instanceof Error ? err.message : "unknown");
    }
  }
  const withStage = <T extends { id: string }>(rows: T[]) =>
    rows.map((r) => ({ ...r, stage: stages.get(r.id)?.stage ?? null }));
  if (viewer) {
    const masked = (data as unknown as RawEnquiryRow[]).map((row) => ({
      ...row,
      payload: row.payload?.name ? { name: row.payload.name } : null,
      lead: row.lead ? { ...row.lead, mobile: null } : row.lead,
    }));
    return NextResponse.json({ data: masked, summary: { ...summary, spam: spamCount ?? 0 } });
  }

  return NextResponse.json({ data: withStage(data as unknown as { id: string }[]), summary: { ...summary, spam: spamCount ?? 0 } });
}
