import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type {
  FacilityIssue, FacilityIssuePriority, FacilityScope,
  FacilityHotSpot, FacilityCategoryBreakdownRow, FacilityTrendPoint,
  FacilityRecurringIssue, FacilityDashboardSummary,
} from "@/types";

/**
 * GET /api/facility/dashboard
 * Query: ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&scope=it&location_id=...
 *
 * Returns:
 *   {
 *     summary: FacilityDashboardSummary,
 *     hot_spots: FacilityHotSpot[],
 *     by_category: FacilityCategoryBreakdownRow[],
 *     trend: FacilityTrendPoint[],
 *     recurring: FacilityRecurringIssue[],
 *     idle_or_breached: FacilityIssue[]   // open + SLA-breached, ordered oldest-first
 *   }
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope") as FacilityScope | null;
  const locationId = searchParams.get("location_id");

  const now = new Date();
  const dateFromStr = searchParams.get("date_from");
  const dateToStr = searchParams.get("date_to");
  const dateFrom = dateFromStr ? new Date(dateFromStr) : new Date(now.getTime() - 30 * 86400000);
  const dateTo = dateToStr ? new Date(dateToStr) : now;
  const periodDays = Math.max(1, Math.round((dateTo.getTime() - dateFrom.getTime()) / 86400000));
  const prevTo = new Date(dateFrom);
  const prevFrom = new Date(prevTo.getTime() - periodDays * 86400000);

  // ---- pull issues for current + prev periods ---------------------------------
  const baseSelect = `
    id, issue_number, scope, status, priority, location_id, category_id, asset_id,
    created_at, resolved_at, sla_target_at, sla_breached, resolution_time_minutes
  `;

  let curQ = supabase
    .from("facility_issues")
    .select(baseSelect)
    .gte("created_at", dateFrom.toISOString())
    .lte("created_at", dateTo.toISOString());
  if (scope) curQ = curQ.eq("scope", scope);
  if (locationId) curQ = curQ.eq("location_id", locationId);

  let prevQ = supabase
    .from("facility_issues")
    .select(baseSelect)
    .gte("created_at", prevFrom.toISOString())
    .lt("created_at", dateFrom.toISOString());
  if (scope) prevQ = prevQ.eq("scope", scope);
  if (locationId) prevQ = prevQ.eq("location_id", locationId);

  const [curRes, prevRes, openRes, locRes, catRes] = await Promise.all([
    curQ,
    prevQ,
    supabase.from("facility_issues").select(`
      *, location:locations(id, name, code),
      category:facility_asset_categories(id, name, slug, scope, icon),
      assignee:users!facility_issues_assigned_to_fkey(id, full_name)
    `).in("status", ["new", "acknowledged", "in_progress", "reopened"]),
    supabase.from("locations").select("id, name").eq("is_active", true),
    supabase.from("facility_asset_categories").select("id, name, scope"),
  ]);

  if (curRes.error)  return NextResponse.json({ error: curRes.error.message  }, { status: 500 });
  if (prevRes.error) return NextResponse.json({ error: prevRes.error.message }, { status: 500 });
  if (openRes.error) return NextResponse.json({ error: openRes.error.message }, { status: 500 });

  const cur = (curRes.data ?? []) as Array<{
    id: string; status: string; priority: FacilityIssuePriority;
    location_id: string; category_id: string; asset_id: string | null;
    created_at: string; resolved_at: string | null;
    sla_target_at: string | null; sla_breached: boolean;
    resolution_time_minutes: number | null;
  }>;
  const prev = (prevRes.data ?? []) as typeof cur;
  const open = (openRes.data ?? []) as unknown as FacilityIssue[];
  const locations = (locRes.data ?? []) as Array<{ id: string; name: string }>;
  const categories = (catRes.data ?? []) as Array<{ id: string; name: string; scope: string }>;

  const locName = new Map(locations.map((l) => [l.id, l.name]));
  const catName = new Map(categories.map((c) => [c.id, c.name]));

  // ---- summary -------------------------------------------------------------
  const openByPriority: Record<FacilityIssuePriority, number> = {
    critical: 0, high: 0, medium: 0, low: 0,
  };
  let slaBreachedOpen = 0;
  for (const o of open) {
    openByPriority[o.priority] = (openByPriority[o.priority] ?? 0) + 1;
    if (o.sla_breached) slaBreachedOpen += 1;
  }

  const resolvedCur = cur.filter((i) => i.status === "resolved" || i.status === "closed");
  const resolvedPrev = prev.filter((i) => i.status === "resolved" || i.status === "closed");

  const sumRes = resolvedCur.reduce((acc, i) => acc + (i.resolution_time_minutes ?? 0), 0);
  const avgResolution = resolvedCur.length > 0 ? Math.round(sumRes / resolvedCur.length) : 0;

  const slaScored = (rows: typeof cur) => {
    const eligible = rows.filter((i) => i.resolved_at && i.sla_target_at);
    if (eligible.length === 0) return 100;
    const within = eligible.filter((i) => !i.sla_breached).length;
    return Math.round((within / eligible.length) * 1000) / 10;
  };
  const slaCompliancePct = slaScored(cur);
  const slaCompliancePctPrev = slaScored(prev);

  const summary: FacilityDashboardSummary = {
    open_count: open.length,
    open_by_priority: openByPriority,
    resolved_period: resolvedCur.length,
    resolved_period_prev: resolvedPrev.length,
    avg_resolution_minutes: avgResolution,
    sla_compliance_pct: slaCompliancePct,
    sla_compliance_pct_prev: slaCompliancePctPrev,
    sla_breached_open: slaBreachedOpen,
  };

  // ---- hot spots (locations with most issues this period) ------------------
  const byLoc = new Map<string, { total: number; by_priority: Record<FacilityIssuePriority, number> }>();
  for (const i of cur) {
    const cur1 = byLoc.get(i.location_id) || {
      total: 0, by_priority: { critical: 0, high: 0, medium: 0, low: 0 },
    };
    cur1.total += 1;
    cur1.by_priority[i.priority] = (cur1.by_priority[i.priority] ?? 0) + 1;
    byLoc.set(i.location_id, cur1);
  }
  const hotSpots: FacilityHotSpot[] = Array.from(byLoc.entries())
    .map(([location_id, v]) => ({
      location_id,
      location_name: locName.get(location_id) ?? "Unknown",
      total_issues: v.total,
      by_priority: v.by_priority,
    }))
    .sort((a, b) => b.total_issues - a.total_issues)
    .slice(0, 10);

  // ---- category breakdown per location ------------------------------------
  const byLocCat = new Map<string, Map<string, number>>();
  for (const i of cur) {
    let perLoc = byLocCat.get(i.location_id);
    if (!perLoc) { perLoc = new Map(); byLocCat.set(i.location_id, perLoc); }
    perLoc.set(i.category_id, (perLoc.get(i.category_id) ?? 0) + 1);
  }
  const byCategory: FacilityCategoryBreakdownRow[] = Array.from(byLocCat.entries()).map(([locId, perLoc]) => ({
    location_id: locId,
    location_name: locName.get(locId) ?? "Unknown",
    by_category: Array.from(perLoc.entries())
      .map(([cid, n]) => ({ category_id: cid, category_name: catName.get(cid) ?? "Unknown", count: n }))
      .sort((a, b) => b.count - a.count),
  }));

  // ---- trend over time (weekly buckets) ------------------------------------
  const weekKey = (d: Date) => {
    const y = d.getUTCFullYear();
    const start = new Date(Date.UTC(y, 0, 1));
    const week = Math.floor((d.getTime() - start.getTime()) / (7 * 86400000)) + 1;
    return `${y}-W${String(week).padStart(2, "0")}`;
  };
  const trendMap = new Map<string, { total: number; by_location: Record<string, number> }>();
  for (const i of cur) {
    const k = weekKey(new Date(i.created_at));
    const t = trendMap.get(k) || { total: 0, by_location: {} };
    t.total += 1;
    t.by_location[i.location_id] = (t.by_location[i.location_id] ?? 0) + 1;
    trendMap.set(k, t);
  }
  const trend: FacilityTrendPoint[] = Array.from(trendMap.entries())
    .map(([bucket, v]) => ({ bucket, total: v.total, by_location: v.by_location }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  // ---- recurring issues (asset OR location+category seen 3+ times) --------
  const recurMap = new Map<string, FacilityRecurringIssue>();
  // Look back over a longer window for recurrence detection (cur + prev)
  const all = [...cur, ...prev];
  for (const i of all) {
    const key = i.asset_id
      ? `asset:${i.asset_id}`
      : `lc:${i.location_id}:${i.category_id}`;
    const existing = recurMap.get(key);
    if (existing) {
      existing.count += 1;
      if (i.created_at > existing.last_at) existing.last_at = i.created_at;
    } else {
      recurMap.set(key, {
        asset_id: i.asset_id ?? null,
        asset_name: null,
        asset_code: null,
        location_id: i.location_id,
        location_name: locName.get(i.location_id) ?? "Unknown",
        category_id: i.category_id,
        category_name: catName.get(i.category_id) ?? "Unknown",
        count: 1,
        last_at: i.created_at,
      });
    }
  }
  // Enrich asset names in one query
  const assetIds = Array.from(recurMap.values()).map((r) => r.asset_id).filter(Boolean) as string[];
  if (assetIds.length > 0) {
    const { data: assets } = await supabase
      .from("facility_assets")
      .select("id, name, asset_code")
      .in("id", assetIds);
    const am = new Map((assets ?? []).map((a) => [a.id, a]));
    for (const r of recurMap.values()) {
      if (r.asset_id) {
        const a = am.get(r.asset_id);
        if (a) { r.asset_name = a.name; r.asset_code = a.asset_code; }
      }
    }
  }
  const recurring: FacilityRecurringIssue[] = Array.from(recurMap.values())
    .filter((r) => r.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // ---- idle / breached open issues ---------------------------------------
  const idleOrBreached: FacilityIssue[] = open
    .filter((i) => i.sla_breached)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(0, 20);

  return NextResponse.json({
    data: {
      summary,
      hot_spots: hotSpots,
      by_category: byCategory,
      trend,
      recurring,
      idle_or_breached: idleOrBreached,
      period: { from: dateFrom.toISOString(), to: dateTo.toISOString() },
    },
  });
}
