/**
 * GET /api/leads/[id]/value/journey
 *
 * Journey sub-tab of the lead's Value tab (docs/customer-value-tab-spec.md,
 * section 5.1): customer age, breaks, renewals, extensions, rent over time and
 * escalation history, across every contract the lead has ever had.
 *
 * Read-only. Computed on read from contracts and rate phases (a handful of rows
 * per customer), so no snapshot is needed in this phase. Sends nothing to any
 * customer and writes nothing.
 *
 * Auth: admin only. The Value tab shows cost and negotiation data.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { buildJourney, todayYmdIst } from "@/lib/customer-value/journey";
import { loadLeadContracts } from "@/lib/customer-value/load-contracts";

export const maxDuration = 30;

const paramsSchema = z.object({ id: z.string().uuid() });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  }
  const leadId = parsed.data.id;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("role")
    .eq("auth_id", user.id)
    .single();
  if (dbUser?.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [leadRes, loaded] = await Promise.all([
    supabase.from("leads").select("created_at, source").eq("id", leadId).maybeSingle(),
    loadLeadContracts(supabase, leadId),
  ]);

  if (leadRes.error || "error" in loaded) {
    console.error(
      "[api/leads/value/journey] query failed:",
      leadRes.error?.message ?? ("error" in loaded ? loaded.error : "")
    );
    return NextResponse.json({ error: "Failed to load journey" }, { status: 500 });
  }
  if (!leadRes.data) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const journey = buildJourney({
    lead: { created_at: leadRes.data.created_at, source: leadRes.data.source ?? null },
    contracts: loaded.contracts,
    today: todayYmdIst(),
  });

  return NextResponse.json(
    { journey },
    // Contracts change a few times a month at most; a short private cache keeps
    // sub-tab revisits cheap without ever serving stale data for long.
    { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=120" } }
  );
}
