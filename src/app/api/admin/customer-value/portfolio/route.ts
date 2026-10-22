/**
 * GET /api/admin/customer-value/portfolio
 *
 * Every customer with a score, as one row each: tier, the change over 90 days,
 * the pillars, shadow margin, days to renewal and insight tags
 * (docs/plans/customer-value-phase6-portfolio.md). Stored figures only, so the
 * page sorts and filters in the browser from this one payload. Read only; admin
 * only (cost and margin data).
 */

import { NextResponse } from "next/server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { todayYmdIst } from "@/lib/customer-value/journey";
import { loadPortfolio } from "@/lib/customer-value/portfolio-load";

export const maxDuration = 60;

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (dbUser?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const today = todayYmdIst();
    const rows = await loadPortfolio(createAdminClient(), today);
    return NextResponse.json({ today, rows }, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (err) {
    console.error("[api/admin/customer-value/portfolio] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to load the portfolio" }, { status: 500 });
  }
}
