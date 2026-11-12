/**
 * GET /api/leads/[id]/value/costs
 *
 * Costs sub-tab of the lead's Value tab (docs/plans/customer-value-phase5-cost-simulator.md):
 * one customer's measured monthly figures and the cost rates that apply to them.
 * The page does the arithmetic in the browser (`simulate`), so the what-if sliders
 * are instant and only this one small payload is fetched. The loading lives in
 * `costs-load`, shared with the renewal outlook. Read only; admin only.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { istToday } from "@/lib/energy-baseline";
import { loadCostsBase } from "@/lib/customer-value/costs-load";

export const maxDuration = 30;

const paramsSchema = z.object({ id: z.string().uuid() });

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  const leadId = parsed.data.id;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (dbUser?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    return NextResponse.json(await loadCostsBase(supabase, leadId, istToday()), { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("[api/leads/value/costs] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to load costs" }, { status: 500 });
  }
}
