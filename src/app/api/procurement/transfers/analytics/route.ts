import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const CROSS_LOCATION_ROLES = ["admin", "manager", "office_admin"];
const WEEKS = 10;

function average(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * GET /api/procurement/transfers/analytics?location_id=X&item_id=Y
 *
 * Dive-deeper data behind the approval-screen anomaly flag: weekly
 * consumption/headcount/usage-per-head trend, past request history for
 * this item at this location, and — when the local trend is too thin to
 * trust — a breakdown of which peer locations fed the fallback benchmark.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const locationId = searchParams.get("location_id");
  const itemId = searchParams.get("item_id");
  if (!locationId || !itemId) {
    return NextResponse.json({ error: "location_id and item_id are required" }, { status: 400 });
  }

  if (!CROSS_LOCATION_ROLES.includes(dbUser.role)) {
    const { data: assignedRows } = await supabase
      .from("user_locations")
      .select("location_id")
      .eq("user_id", dbUser.id);
    const assignedIds = new Set((assignedRows ?? []).map((r: { location_id: string }) => r.location_id));
    if (!assignedIds.has(locationId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const now = new Date();
  const windowStart = new Date(now.getTime() - WEEKS * 7 * 24 * 60 * 60 * 1000);

  const [{ data: logItems }, { data: headcountReadings }, { data: itemRows }] = await Promise.all([
    supabase
      .from("consumption_log_items")
      .select("quantity_consumed, consumption_logs!inner(logged_at, location_id, status)")
      .eq("item_id", itemId)
      .eq("consumption_logs.location_id", locationId)
      .eq("consumption_logs.status", "active")
      .gte("consumption_logs.logged_at", windowStart.toISOString()),
    supabase
      .from("space_headcounts")
      .select("recorded_at, total_count")
      .eq("location_id", locationId)
      .gte("recorded_at", windowStart.toISOString()),
    supabase
      .from("stock_transfer_items")
      .select("quantity_requested, quantity_approved, item_id, stock_transfers!inner(transfer_number, status, created_at, to_location_id)")
      .eq("item_id", itemId)
      .eq("stock_transfers.to_location_id", locationId)
      .order("created_at", { referencedTable: "stock_transfers", ascending: false })
      .limit(10),
  ]);

  type LogItemRow = { quantity_consumed: number; consumption_logs: { logged_at: string } };
  const consumptionRows = (logItems ?? []) as unknown as LogItemRow[];
  const headcountRows = (headcountReadings ?? []) as Array<{ recorded_at: string; total_count: number }>;

  // Bucket into WEEKS trailing 7-day windows, oldest first.
  const weeklyTrend = Array.from({ length: WEEKS }, (_, i) => {
    const bucketStart = new Date(windowStart.getTime() + i * 7 * 24 * 60 * 60 * 1000);
    const bucketEnd = new Date(bucketStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const consumption = consumptionRows
      .filter((r) => {
        const t = new Date(r.consumption_logs.logged_at).getTime();
        return t >= bucketStart.getTime() && t < bucketEnd.getTime();
      })
      .reduce((sum, r) => sum + Number(r.quantity_consumed), 0);
    const headcount = average(
      headcountRows
        .filter((r) => {
          const t = new Date(r.recorded_at).getTime();
          return t >= bucketStart.getTime() && t < bucketEnd.getTime();
        })
        .map((r) => Number(r.total_count))
    );
    return {
      weekStart: bucketStart.toISOString().slice(0, 10),
      consumption,
      headcount,
      usagePerHead: headcount && headcount > 0 ? consumption / headcount : null,
    };
  });

  type RequestHistoryRow = {
    quantity_requested: number;
    quantity_approved: number | null;
    stock_transfers: { transfer_number: string; status: string; created_at: string };
  };
  const requestHistory = ((itemRows ?? []) as unknown as RequestHistoryRow[]).map((r) => ({
    transferNumber: r.stock_transfers.transfer_number,
    date: r.stock_transfers.created_at,
    status: r.stock_transfers.status,
    requested: r.quantity_requested,
    approved: r.quantity_approved,
  }));

  // Peer breakdown — same locations/logic the approval-screen benchmark
  // itself draws from, so this dialog can show its actual source data.
  const { data: peerLogItems } = await supabase
    .from("consumption_log_items")
    .select("quantity_consumed, consumption_logs!inner(location_id, logged_at, status)")
    .eq("item_id", itemId)
    .neq("consumption_logs.location_id", locationId)
    .eq("consumption_logs.status", "active")
    .gte("consumption_logs.logged_at", new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString());

  type PeerRow = { quantity_consumed: number; consumption_logs: { location_id: string } };
  const peerRows = (peerLogItems ?? []) as unknown as PeerRow[];
  const byLocation = new Map<string, number>();
  for (const r of peerRows) {
    byLocation.set(
      r.consumption_logs.location_id,
      (byLocation.get(r.consumption_logs.location_id) ?? 0) + Number(r.quantity_consumed)
    );
  }

  let peerBreakdown: Array<{ locationName: string; consumption: number; headcount: number | null; usagePerHead: number | null }> = [];
  const peerLocationIds = Array.from(byLocation.keys());
  if (peerLocationIds.length > 0) {
    const [{ data: peerLocations }, { data: peerHeadcounts }] = await Promise.all([
      supabase.from("locations").select("id, name").in("id", peerLocationIds),
      supabase
        .from("space_headcounts")
        .select("location_id, total_count")
        .in("location_id", peerLocationIds)
        .gte("recorded_at", new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()),
    ]);
    const nameById = new Map((peerLocations ?? []).map((l: { id: string; name: string }) => [l.id, l.name]));
    const headcountByLocation = new Map<string, number[]>();
    for (const h of peerHeadcounts ?? []) {
      if (!headcountByLocation.has(h.location_id)) headcountByLocation.set(h.location_id, []);
      headcountByLocation.get(h.location_id)!.push(Number(h.total_count));
    }
    peerBreakdown = peerLocationIds.map((locId) => {
      const avgHc = average(headcountByLocation.get(locId) ?? []);
      const consumed = byLocation.get(locId) ?? 0;
      return {
        locationName: nameById.get(locId) ?? "Unknown location",
        consumption: consumed,
        headcount: avgHc,
        usagePerHead: avgHc && avgHc > 0 ? consumed / avgHc : null,
      };
    });
  }

  return NextResponse.json({
    weekly_trend: weeklyTrend,
    request_history: requestHistory,
    peer_breakdown: peerBreakdown,
  });
}
