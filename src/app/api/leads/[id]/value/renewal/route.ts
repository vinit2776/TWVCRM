/**
 * GET /api/leads/[id]/value/renewal
 *
 * The renewal outlook and cross-pillar insights shown on the Summary sub-tab
 * (docs/plans/customer-value-phase6-portfolio.md). The loading lives in
 * `renewal-load`. Read only; admin only.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { todayYmdIst } from "@/lib/customer-value/journey";
import { loadRenewalOutlook } from "@/lib/customer-value/renewal-load";

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
    const result = await loadRenewalOutlook(supabase, leadId, todayYmdIst());
    if (!result) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    console.error("[api/leads/value/renewal] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to load the renewal outlook" }, { status: 500 });
  }
}
