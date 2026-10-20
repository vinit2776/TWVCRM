/**
 * GET /api/leads/[id]/value/electricity
 *
 * Electricity sub-tab of the lead's Value tab (docs/plans/customer-value-phase4-electricity.md):
 * this customer's share of the center's metered electricity by month, what it
 * costs, and whether what they were billed covers it. The loading lives in
 * `electricity-load` so the Costs sub-tab reads the same figures.
 *
 * Read only; admin only.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { istToday } from "@/lib/energy-baseline";
import { loadCenterCohort } from "@/lib/customer-value/center-cohort";
import { loadElectricity } from "@/lib/customer-value/electricity-load";

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
    const cohort = await loadCenterCohort(supabase, leadId, "live");
    const body = await loadElectricity(supabase, leadId, cohort, istToday());
    return NextResponse.json(body, { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=120" } });
  } catch (err) {
    console.error("[api/leads/value/electricity] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to load electricity" }, { status: 500 });
  }
}
