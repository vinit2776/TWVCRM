import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { CASE_STATUS_GROUPS } from "@/lib/constants";

const INCOMPLETE_GROUPS = ["intake", "review_approval", "execution"];

const STATUS_TO_GROUP: Record<string, string> = {};
for (const [groupKey, group] of Object.entries(CASE_STATUS_GROUPS)) {
  for (const status of group.statuses) STATUS_TO_GROUP[status] = groupKey;
}

/**
 * GET /api/aggregators/case-counts?ids=id1,id2,...
 *
 * Batch case-count summary for the Aggregators list page — same
 * "incomplete" definition (stuck before Active) as the per-aggregator
 * Cases card on the detail page, but grouped for N aggregators in one query
 * instead of one request per row.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const idsParam = request.nextUrl.searchParams.get("ids");
  const ids = (idsParam || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return NextResponse.json({ data: {} });

  const { data: cases, error } = await supabase
    .from("cases")
    .select("aggregator_id, status")
    .in("aggregator_id", ids);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const counts: Record<string, { total: number; incomplete: number }> = {};
  for (const c of cases || []) {
    if (!c.aggregator_id) continue;
    const entry = counts[c.aggregator_id] ?? (counts[c.aggregator_id] = { total: 0, incomplete: 0 });
    entry.total += 1;
    if (INCOMPLETE_GROUPS.includes(STATUS_TO_GROUP[c.status] ?? "")) entry.incomplete += 1;
  }

  return NextResponse.json({ data: counts });
}
