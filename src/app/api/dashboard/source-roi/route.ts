import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

/**
 * GET /api/dashboard/source-roi?location_id=<uuid>
 * Returns per-source: total leads, won count, conversion rate, and total
 * contract value won (sum of contracts.total_amount where contract.lead.source = X).
 *
 * Window: leads created in last 180 days.
 *
 * Access: admin, manager.
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

  if (!dbUser || !["admin", "manager"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const locationId = request.nextUrl.searchParams.get("location_id");
  const since = new Date();
  since.setDate(since.getDate() - 180);

  let leadsQ = adminSupabase
    .from("leads")
    .select("id, source, status, location_id, created_at")
    .gte("created_at", since.toISOString());
  if (locationId) leadsQ = leadsQ.eq("location_id", locationId);

  const { data: leads, error } = await leadsQ;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Lead = { id: string; source: string; status: string };
  const rows = (leads ?? []) as Lead[];
  const wonLeadIds = rows.filter((l) => l.status === "won").map((l) => l.id);

  // Pull contract revenue for these won leads
  let contractsRev = new Map<string, number>(); // lead_id -> sum total_amount
  if (wonLeadIds.length > 0) {
    const { data: contracts } = await adminSupabase
      .from("contracts")
      .select("lead_id, total_amount, status")
      .in("lead_id", wonLeadIds)
      .in("status", ["active", "renewed"]);
    contractsRev = new Map();
    for (const c of contracts ?? []) {
      const id = c.lead_id as string;
      contractsRev.set(id, (contractsRev.get(id) ?? 0) + Number(c.total_amount ?? 0));
    }
  }

  type Bucket = { source: string; total: number; won: number; revenue: number };
  const bySource = new Map<string, Bucket>();
  for (const l of rows) {
    const s = l.source ?? "other";
    if (!bySource.has(s)) bySource.set(s, { source: s, total: 0, won: 0, revenue: 0 });
    const b = bySource.get(s)!;
    b.total += 1;
    if (l.status === "won") {
      b.won += 1;
      b.revenue += contractsRev.get(l.id) ?? 0;
    }
  }

  const sources = Array.from(bySource.values())
    .map((b) => ({
      source: b.source,
      total: b.total,
      won: b.won,
      conversion_pct: b.total > 0 ? Math.round((b.won / b.total) * 100) : 0,
      revenue: Math.round(b.revenue),
    }))
    .sort((a, b) => b.revenue - a.revenue || b.won - a.won);

  return NextResponse.json({
    data: {
      window_days: 180,
      total_leads: rows.length,
      total_won: rows.filter((l) => l.status === "won").length,
      sources,
    },
  });
}
