import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ENQUIRY_SELECT } from "@/lib/enquiries";

// GET /api/leads/enquiry-log — one row per public-form enquiry (lead_enquiries).
//   ?source=google_ads|meta_ads|direct_walkin
//   &outcome=unresolved|converted|not_interested|no_response|superseded
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

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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

  return NextResponse.json({ data, summary });
}
