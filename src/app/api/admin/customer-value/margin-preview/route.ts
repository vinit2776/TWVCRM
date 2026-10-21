/**
 * GET /api/admin/customer-value/margin-preview?weight=40
 *
 * What giving margin after variable costs a weight inside Profitability would do
 * to today's tiers (docs/plans/customer-value-phase5-cost-simulator.md, PR E).
 * Scores every customer twice in memory and reports who would move. Read only:
 * it writes nothing and changes no setting. Admin only.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { todayYmdIst } from "@/lib/customer-value/journey";
import { previewMarginScoring } from "@/lib/customer-value/margin-preview";

export const maxDuration = 60;

const querySchema = z.object({ weight: z.coerce.number().int().min(1).max(100).default(40) });
const MAX_NAMED = 60;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (dbUser?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "weight must be a whole number from 1 to 100" }, { status: 400 });

  try {
    const admin = createAdminClient();
    const preview = await previewMarginScoring(admin, todayYmdIst(), parsed.data.weight);

    const named = preview.tierChanges.slice(0, MAX_NAMED);
    const { data: leads, error } = await admin.from("leads").select("id, first_name, last_name, company").in("id", named.map((c) => c.leadId));
    if (error) throw new Error(error.message);
    const nameOf = new Map((leads ?? []).map((l) => [l.id as string, (l.company as string | null) || `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim() || "Customer"]));

    return NextResponse.json(
      { ...preview, tierChanges: named.map((c) => ({ ...c, name: nameOf.get(c.leadId) ?? "Customer" })), moreChanges: Math.max(0, preview.tierChanges.length - named.length) },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (err) {
    console.error("[api/admin/margin-preview] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to run the preview" }, { status: 500 });
  }
}
