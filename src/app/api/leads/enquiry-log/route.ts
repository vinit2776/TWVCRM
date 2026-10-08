import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const FORM_TAGS = ["google-ads-form", "meta-ads-form", "walkin-form"];

// GET /api/leads/enquiry-log
//   ?source=google_ads|meta_ads|direct_walkin
//   &outcome=unresolved|converted|not_interested|no_response
//   &from=ISO-date   — matches on enquiry ACTIVITY (created, last re-enquiry, or resolved),
//                      not just first creation, so a re-enquiry on an old lead stays visible
//   &include_unresolved=true — also return every unresolved enquiry regardless of age
//   &to=ISO-date
//   &location_id=UUID
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

  let query = supabase
    .from("leads")
    .select(
      "id, first_name, last_name, mobile, email, source, tags, created_at, " +
        "attention_reset_at, claimed_by, claimed_at, resolved_at, resolution_outcome, " +
        "location_id, " +
        "claimer:users!leads_claimed_by_fkey(id, full_name), " +
        "resolver:users!leads_resolved_by_fkey(id, full_name), " +
        "enquiries:lead_enquiries(reference, received_at), " +
        "location:locations!leads_location_id_fkey(id, name, code)"
    )
    .overlaps("tags", FORM_TAGS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (source) query = query.eq("source", source);
  if (locationId) query = query.eq("location_id", locationId);
  if (from) {
    // An old lead that re-submits the form keeps its original created_at; only
    // attention_reset_at moves. Filtering on created_at alone made those vanish.
    const parts = [
      `created_at.gte.${from}`,
      `attention_reset_at.gte.${from}`,
      `resolved_at.gte.${from}`,
    ];
    if (includeUnresolved) parts.push("resolved_at.is.null");
    query = query.or(parts.join(","));
  }
  if (to) query = query.lte("created_at", to);

  if (outcome === "unresolved") query = query.is("resolved_at", null);
  else if (outcome) query = query.eq("resolution_outcome", outcome);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Roll up campaign attribution counts in the same response so the page can
  // show summary tiles without a second round trip.
  type Row = {
    source: string;
    tags: string[] | null;
    resolved_at: string | null;
    resolution_outcome: string | null;
  };
  const summary = (data as unknown as Row[]).reduce(
    (acc, row) => {
      acc.total += 1;
      if (!row.resolved_at) acc.unresolved += 1;
      else if (row.resolution_outcome === "converted") acc.converted += 1;
      else if (row.resolution_outcome === "not_interested") acc.notInterested += 1;
      else if (row.resolution_outcome === "no_response") acc.noResponse += 1;
      return acc;
    },
    { total: 0, unresolved: 0, converted: 0, notInterested: 0, noResponse: 0 }
  );

  return NextResponse.json({ data, summary });
}
