import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/lead-funnel?location_id=<uuid>
 * Returns active-pipeline lead counts per stage, average days-in-stage
 * (proxy: created_at -> now), and aging leads (in non-terminal stage > 7
 * days with no recent activity).
 *
 * Stages excluded: won, lost (terminal, surfaced separately).
 *
 * Access: admin, manager, sales_rep (own leads).
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const adminSupabase = await createAdminClient();
  const { data: dbUser } = await adminSupabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .single();

  if (!dbUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const locationId = request.nextUrl.searchParams.get("location_id");

  let q = adminSupabase
    .from("leads")
    .select("id, status, created_at, updated_at, location_id, assigned_to");

  // Sales rep / floor manager: own leads only
  if (dbUser.role === "sales_rep" || dbUser.role === "floor_manager") {
    q = q.eq("assigned_to", dbUser.id);
  }
  if (locationId) q = q.eq("location_id", locationId);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = { id: string; status: string; created_at: string; updated_at: string };
  const rows = (data ?? []) as Row[];

  const STAGES = [
    "new",
    "contacted",
    "tour_scheduled",
    "tour_completed",
    "proposal_sent",
    "negotiating",
  ] as const;
  type Stage = (typeof STAGES)[number];

  const now = Date.now();
  const byStage = new Map<Stage, { count: number; ageDaysSum: number; aging: number }>();
  for (const s of STAGES) byStage.set(s, { count: 0, ageDaysSum: 0, aging: 0 });

  let won = 0;
  let lost = 0;

  for (const r of rows) {
    const ageDays = (now - new Date(r.updated_at ?? r.created_at).getTime()) / 86_400_000;
    if (r.status === "won") {
      won += 1;
      continue;
    }
    if (r.status === "lost") {
      lost += 1;
      continue;
    }
    const s = r.status as Stage;
    const slot = byStage.get(s);
    if (!slot) continue;
    slot.count += 1;
    slot.ageDaysSum += ageDays;
    if (ageDays > 7) slot.aging += 1;
  }

  const stages = STAGES.map((s) => {
    const slot = byStage.get(s)!;
    const avgAge = slot.count > 0 ? slot.ageDaysSum / slot.count : 0;
    return {
      stage: s,
      count: slot.count,
      avg_days_in_stage: Math.round(avgAge * 10) / 10,
      aging_count: slot.aging,
    };
  });

  const activeTotal = stages.reduce((s, x) => s + x.count, 0);
  const totalAging = stages.reduce((s, x) => s + x.aging_count, 0);
  // Conversion: won / (won + lost) — closed-deal rate
  const closed = won + lost;
  const closedConversion = closed > 0 ? Math.round((won / closed) * 100) : 0;

  return NextResponse.json({
    data: {
      active_total: activeTotal,
      won,
      lost,
      closed_conversion_pct: closedConversion,
      total_aging: totalAging,
      stages,
    },
  });
}
