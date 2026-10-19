/**
 * POST /api/leads/[id]/value/recompute
 *
 * Recomputes one customer's monthly figures and today's Value score and stores
 * them. Admin only. Takes no body.
 *
 * Writes only the two snapshot tables; sends nothing to any customer. Scores are
 * ranked against the other customers at the same center, so this loads every
 * customer even though it writes just one: it is a deliberate button press, not
 * something to call in a loop.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { todayYmdIst } from "@/lib/customer-value/journey";
import { refreshScores } from "@/lib/customer-value/scores-refresh";

export const maxDuration = 60;

const paramsSchema = z.object({ id: z.string().uuid() });

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  const leadId = parsed.data.id;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: dbUser } = await admin.from("users").select("role").eq("auth_id", user.id).single();
  if (dbUser?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: lead } = await admin.from("leads").select("id").eq("id", leadId).maybeSingle();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  try {
    const r = await refreshScores(admin, todayYmdIst(), { write: true, scores: "latest", writeLeadIds: [leadId] });
    const score = r.latest.get(leadId) ?? null;
    return NextResponse.json({
      recomputed: true,
      monthly_rows: r.monthlyRows,
      warnings: r.warnings,
      score: score && {
        as_of: score.as_of,
        status: score.status,
        tier: score.tier,
        overall: score.overall,
        trend_vs_90d: score.trend_vs_90d,
      },
    });
  } catch (err) {
    console.error("[customer-value/recompute] failed:", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Recompute failed" }, { status: 500 });
  }
}
