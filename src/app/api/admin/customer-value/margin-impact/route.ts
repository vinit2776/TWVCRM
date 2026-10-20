/**
 * GET /api/admin/customer-value/margin-impact?min_confidence=0.5
 *
 * What switching margin scoring on would change (see `compareMarginImpact`): every
 * customer scored today as scoring stands and again with margin after variable
 * costs counted in Profitability, and who moves. Read-only: it writes nothing and
 * does not flip the switch. Admin only. It scores everyone, so it is as heavy as
 * the nightly run; use it when deciding, not on a page load.
 *
 * `min_confidence` tries a different floor for how much of a month's cost must
 * rest on measured data before that month's margin counts (default: the saved
 * setting).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { todayYmdIst } from "@/lib/customer-value/journey";
import { compareMarginImpact } from "@/lib/customer-value/margin-impact";
import { loadMarginsByLead } from "@/lib/customer-value/margin-load";
import { listCustomerIds } from "@/lib/customer-value/scores-refresh";
import type { RunCustomer } from "@/lib/customer-value/scoring-run";
import { SCORING_SETTINGS_KEY, loadSettings } from "@/lib/customer-value/scoring-settings-store";
import { loadCustomers } from "@/lib/customer-value/snapshot-load";

export const maxDuration = 60;

const querySchema = z.object({ min_confidence: z.coerce.number().min(0).max(1).optional() });

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (dbUser?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "min_confidence must be a number from 0 to 1" }, { status: 400 });

  try {
    // Heavy, cross-customer reads: service role, after the admin check above.
    const admin = createAdminClient();
    const { data: settingRow } = await admin.from("app_settings").select("value").eq("key", SCORING_SETTINGS_KEY).maybeSingle();
    const { settings, warning } = loadSettings((settingRow as { value?: string } | null)?.value ?? null);
    const tried = parsed.data.min_confidence ?? settings.margin.minConfidence;

    const ids = await listCustomerIds(admin);
    const [assembled, margins] = await Promise.all([loadCustomers(admin, ids), loadMarginsByLead(admin)]);
    const customers: RunCustomer[] = ids
      .map((id) => assembled.get(id))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .map((c) => ({ leadId: c.leadId, raw: c.raw, locationIds: c.locationIds, ticketLinkCoverage: c.ticketLinkCoverage, margins: margins.get(c.leadId) ?? [] }));

    const today = todayYmdIst();
    const impact = compareMarginImpact(customers, today, { ...settings, margin: { ...settings.margin, minConfidence: tried } });

    const moverIds = impact.movers.map((m) => m.leadId);
    const { data: leads } = moverIds.length
      ? await admin.from("leads").select("id, first_name, last_name, company").in("id", moverIds)
      : { data: [] as Array<{ id: string; first_name: string | null; last_name: string | null; company: string | null }> };
    const names = new Map((leads ?? []).map((l) => [l.id, l.company || `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim() || "Customer"]));

    return NextResponse.json(
      {
        marginScoringEnabled: settings.margin.enabled,
        minConfidenceTried: tried,
        settingsWarning: warning,
        ...impact,
        movers: impact.movers.map((m) => ({ ...m, name: names.get(m.leadId) ?? "Customer" })),
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[api/admin/customer-value/margin-impact] failed:", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Failed to compare" }, { status: 500 });
  }
}
