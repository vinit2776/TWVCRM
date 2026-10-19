/**
 * GET /api/leads/[id]/value/compare
 *
 * Compare sub-tab of the lead's Value tab (docs/customer-value-tab-spec.md,
 * section 5.4): this customer against the other customers at the same center.
 *
 * "Same center" means what scoring means by it: each customer belongs to their
 * first location, so the cohort here is the cohort their score was ranked in.
 * Reads the stored monthly rows only (never invoices or tickets) and does the
 * arithmetic in `compare-view`. Read only; admin only; uses the signed-in
 * user's client so the tables' admin-only RLS is a second gate.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { todayYmdIst } from "@/lib/customer-value/journey";
import { buildComparison, type CompareMonthRow } from "@/lib/customer-value/compare-view";
import { fetchInChunks, type PageResult } from "@/lib/customer-value/query-helpers";
import { primaryLocation } from "@/lib/customer-value/scoring-run";

export const maxDuration = 30;

const paramsSchema = z.object({ id: z.string().uuid() });

/** Twelve months of history: the window being compared plus the trend line. */
const HISTORY_DAYS = 400;

interface ContractLocation {
  id: string;
  lead_id: string;
  location_id: string | null;
}

function daysBefore(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  const leadId = parsed.data.id;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("role").eq("auth_id", user.id).single();
  if (dbUser?.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const today = todayYmdIst();

  try {
    const { data: mine, error: mineError } = await supabase
      .from("contracts")
      .select("id, lead_id, location_id")
      .eq("lead_id", leadId)
      .returns<ContractLocation[]>();
    if (mineError) throw new Error(mineError.message);

    const center = primaryLocation({ locationIds: (mine ?? []).map((c) => c.location_id).filter((l): l is string => Boolean(l)) });
    if (!center) {
      return NextResponse.json({ today, center: null, comparison: null }, { headers: { "Cache-Control": "private, max-age=60" } });
    }

    const [{ data: location }, atCenter] = await Promise.all([
      supabase.from("locations").select("name").eq("id", center).single(),
      fetchInChunks<ContractLocation>("center contracts", [center], (batch, from, to): PromiseLike<PageResult<ContractLocation>> =>
        supabase.from("contracts").select("id, lead_id, location_id").in("location_id", batch).order("id").range(from, to)
      ),
    ]);

    // A customer is ranked at their first location, so a lead whose other contracts
    // sit elsewhere may belong to a different center than this contract suggests.
    const candidateLeads = [...new Set(atCenter.map((c) => c.lead_id))];
    const allContracts = await fetchInChunks<ContractLocation>("candidate contracts", candidateLeads, (batch, from, to) =>
      supabase.from("contracts").select("id, lead_id, location_id").in("lead_id", batch).order("id").range(from, to)
    );
    const locationsByLead = new Map<string, string[]>();
    for (const c of allContracts) {
      if (c.location_id) locationsByLead.set(c.lead_id, [...(locationsByLead.get(c.lead_id) ?? []), c.location_id]);
    }
    const cohortLeads = candidateLeads.filter((id) => primaryLocation({ locationIds: locationsByLead.get(id) ?? [] }) === center);
    if (!cohortLeads.includes(leadId)) cohortLeads.push(leadId);

    const since = daysBefore(today, HISTORY_DAYS);
    const rows = await fetchInChunks<CompareMonthRow>("monthly rows", cohortLeads, (batch, from, to) =>
      supabase
        .from("customer_value_monthly")
        .select("lead_id, month, avg_days_late, measured_count, on_time_count, reminders, seats_paid, seats_used_avg, rent_per_seat, tickets_linked")
        .in("lead_id", batch)
        .gte("month", since)
        .order("lead_id")
        .order("month")
        .range(from, to)
    );

    // Numeric columns can arrive as strings.
    const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const clean: CompareMonthRow[] = rows.map((r) => ({
      ...r,
      avg_days_late: n(r.avg_days_late), seats_paid: n(r.seats_paid), seats_used_avg: n(r.seats_used_avg), rent_per_seat: n(r.rent_per_seat),
    }));

    return NextResponse.json(
      { today, center: { id: center, name: location?.name ?? "this center" }, comparison: buildComparison(leadId, clean, today) },
      { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=120" } }
    );
  } catch (err) {
    console.error("[api/leads/value/compare] failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Failed to load the comparison" }, { status: 500 });
  }
}
