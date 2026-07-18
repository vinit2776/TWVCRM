import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { hasRole, FACILITY_ROLES } from "@/lib/facility";
import type { FacilityIssuePriority } from "@/types";

// Suggest-only, no auto-write — mirrors the MOQ replenishment pattern
// (src/app/api/procurement/replenishment/route.ts). Nothing here mutates
// facility_asset_categories; the caller applies a suggestion via the
// existing PUT /api/facility/categories/[id] endpoint.

const WINDOW_DAYS = 90;
const MIN_SAMPLE_SIZE = 5;
const MEANINGFUL_DELTA_PCT = 20; // only surface a suggestion if it differs from the current default by this much

const DEFAULT_FIELD: Record<FacilityIssuePriority, string> = {
  critical: "default_sla_critical_hrs",
  high: "default_sla_high_hrs",
  medium: "default_sla_medium_hrs",
  low: "default_sla_low_hrs",
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!hasRole(dbUser?.role, FACILITY_ROLES.manage)) {
    return NextResponse.json({ error: "Admin or IT Manager access required" }, { status: 403 });
  }

  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

  const [{ data: resolved, error: resolvedErr }, { data: categories, error: catErr }] = await Promise.all([
    supabase
      .from("facility_issues")
      .select("category_id, priority, resolution_time_minutes")
      .eq("task_type", "reported_problem")
      .in("status", ["resolved", "closed"])
      .not("category_id", "is", null)
      .not("resolution_time_minutes", "is", null)
      .gte("resolved_at", windowStart),
    supabase
      .from("facility_asset_categories")
      .select("id, name, scope, default_sla_critical_hrs, default_sla_high_hrs, default_sla_medium_hrs, default_sla_low_hrs")
      .eq("is_active", true),
  ]);

  if (resolvedErr) return NextResponse.json({ error: resolvedErr.message }, { status: 500 });
  if (catErr) return NextResponse.json({ error: catErr.message }, { status: 500 });

  const categoryById = new Map((categories ?? []).map((c) => [c.id, c]));

  // Group resolution times (minutes -> hours) by category_id + priority
  const buckets = new Map<string, number[]>();
  for (const row of resolved ?? []) {
    if (!row.category_id || !row.priority || row.resolution_time_minutes == null) continue;
    const key = `${row.category_id}::${row.priority}`;
    const hours = Number(row.resolution_time_minutes) / 60;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(hours);
  }

  const suggestions: Array<{
    category_id: string;
    category_name: string;
    scope: string;
    priority: FacilityIssuePriority;
    sample_size: number;
    median_hours: number;
    current_default_hours: number;
    delta_pct: number;
  }> = [];

  for (const [key, hoursList] of buckets) {
    if (hoursList.length < MIN_SAMPLE_SIZE) continue;
    const [categoryId, priority] = key.split("::") as [string, FacilityIssuePriority];
    const category = categoryById.get(categoryId);
    if (!category) continue;

    const currentDefault = Number(category[DEFAULT_FIELD[priority] as keyof typeof category]) || 0;
    const medianHours = Math.round(median(hoursList) * 10) / 10;
    if (currentDefault <= 0) continue;

    const deltaPct = Math.round(Math.abs(medianHours - currentDefault) / currentDefault * 1000) / 10;
    if (deltaPct < MEANINGFUL_DELTA_PCT) continue;

    suggestions.push({
      category_id: categoryId,
      category_name: category.name,
      scope: category.scope,
      priority,
      sample_size: hoursList.length,
      median_hours: medianHours,
      current_default_hours: currentDefault,
      delta_pct: deltaPct,
    });
  }

  suggestions.sort((a, b) => b.delta_pct - a.delta_pct);

  return NextResponse.json({ data: suggestions, window_days: WINDOW_DAYS, min_sample_size: MIN_SAMPLE_SIZE });
}
