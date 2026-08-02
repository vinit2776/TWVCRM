import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computePeriodBounds, type ActivityRange } from "@/lib/activity-period";

const VALID_RANGES: ActivityRange[] = ["hour", "day", "week", "month", "quarter", "year", "custom"];

// Aggregation cap for the entity_type/action breakdown — an internal CRM's per-user,
// per-period activity volume shouldn't approach this, but if it ever does, the
// response says so via `breakdown_truncated` rather than silently under-counting.
const BREAKDOWN_ROW_CAP = 10000;

/**
 * GET /api/users/[id]/activity — the activity storyboard's data source.
 *
 * Distinct from the existing /api/users/[id]/activity-log (which powers the
 * unrestricted per-user dialog on /team): this endpoint enforces the
 * self/admin/manager visibility rule and adds the breakdown + trend views,
 * so it's kept as a separate route rather than retrofitting the older one.
 *
 * Query params:
 *   range   — hour|day|week|month|quarter|year|custom (default "month")
 *   start/end — ISO timestamps, required when range=custom
 *   limit/offset — timeline pagination (default 50, max 100)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: targetUserId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const isSelf = dbUser.id === targetUserId;
  const isAdminOrManager = dbUser.role === "admin" || dbUser.role === "manager";
  if (!isSelf && !isAdminOrManager) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const rangeParam = searchParams.get("range") || "month";
  if (!VALID_RANGES.includes(rangeParam as ActivityRange)) {
    return NextResponse.json({ error: `Invalid range: ${rangeParam}` }, { status: 400 });
  }
  const range = rangeParam as ActivityRange;

  let custom: { start: Date; end: Date } | undefined;
  if (range === "custom") {
    const startParam = searchParams.get("start");
    const endParam = searchParams.get("end");
    if (!startParam || !endParam) {
      return NextResponse.json({ error: "custom range requires start and end" }, { status: 400 });
    }
    const start = new Date(startParam);
    const end = new Date(endParam);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) {
      return NextResponse.json({ error: "Invalid start/end" }, { status: 400 });
    }
    custom = { start, end };
  }

  const limit = Math.min(Number(searchParams.get("limit") || 50), 100);
  const offset = Number(searchParams.get("offset") || 0);

  const { currentStart, currentEnd, previousStart, previousEnd } = computePeriodBounds(
    range,
    new Date(),
    custom
  );

  const [timelineResult, breakdownResult, previousCountResult] = await Promise.all([
    supabase
      .from("audit_trail")
      .select("id, entity_type, entity_id, action, changes, created_at", { count: "exact" })
      .eq("performed_by", targetUserId)
      .gte("created_at", currentStart.toISOString())
      .lt("created_at", currentEnd.toISOString())
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1),
    supabase
      .from("audit_trail")
      .select("entity_type, action")
      .eq("performed_by", targetUserId)
      .gte("created_at", currentStart.toISOString())
      .lt("created_at", currentEnd.toISOString())
      .limit(BREAKDOWN_ROW_CAP),
    supabase
      .from("audit_trail")
      .select("id", { count: "exact", head: true })
      .eq("performed_by", targetUserId)
      .gte("created_at", previousStart.toISOString())
      .lt("created_at", previousEnd.toISOString()),
  ]);

  if (timelineResult.error) {
    return NextResponse.json({ error: timelineResult.error.message }, { status: 500 });
  }
  if (breakdownResult.error) {
    return NextResponse.json({ error: breakdownResult.error.message }, { status: 500 });
  }

  const breakdownMap = new Map<string, number>();
  for (const row of breakdownResult.data || []) {
    const key = `${row.entity_type}:${row.action}`;
    breakdownMap.set(key, (breakdownMap.get(key) || 0) + 1);
  }
  const breakdown = Array.from(breakdownMap.entries())
    .map(([key, count]) => {
      const [entity_type, action] = key.split(":");
      return { entity_type, action, count };
    })
    .sort((a, b) => b.count - a.count);

  const currentCount = timelineResult.count ?? 0;
  const previousCount = previousCountResult.count ?? 0;
  const delta = currentCount - previousCount;
  const deltaPct = previousCount > 0 ? (delta / previousCount) * 100 : null;

  return NextResponse.json({
    data: {
      timeline: timelineResult.data || [],
      total: currentCount,
      limit,
      offset,
      breakdown,
      breakdown_truncated: (breakdownResult.data || []).length >= BREAKDOWN_ROW_CAP,
      period: { start: currentStart.toISOString(), end: currentEnd.toISOString() },
      trend: {
        current_count: currentCount,
        previous_count: previousCount,
        previous_period: { start: previousStart.toISOString(), end: previousEnd.toISOString() },
        delta,
        delta_pct: deltaPct,
      },
    },
  });
}
