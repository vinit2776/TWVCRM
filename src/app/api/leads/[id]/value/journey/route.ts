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
import {
  buildJourney,
  todayYmdIst,
  type JourneyContractRow,
} from "@/lib/customer-value/journey";
import type { RatePhaseInput } from "@/lib/rate-phase-dates";

export const maxDuration = 30;

const paramsSchema = z.object({ id: z.string().uuid() });

const CONTRACT_COLUMNS =
  "id, contract_number, status, start_date, end_date, activated_at, terminated_at, seats, subtotal, " +
  "escalation_percentage, escalation_waived, escalation_approval_status, parent_contract_id, " +
  "renewal_sequence, days_extended, phase_start_date, renewal_declined";

type ContractRecord = Omit<JourneyContractRow, "rate_phases">;
type PhaseRecord = RatePhaseInput & { contract_id: string };

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

  const [leadRes, contractsRes] = await Promise.all([
    supabase.from("leads").select("created_at, source").eq("id", leadId).maybeSingle(),
    supabase
      .from("contracts")
      .select(CONTRACT_COLUMNS)
      .eq("lead_id", leadId)
      .returns<ContractRecord[]>(),
  ]);

  if (leadRes.error || contractsRes.error) {
    console.error("[api/leads/value/journey] query failed:", leadRes.error?.message ?? contractsRes.error?.message);
    return NextResponse.json({ error: "Failed to load journey" }, { status: 500 });
  }
  if (!leadRes.data) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const contracts = contractsRes.data ?? [];
  const phasesByContract = new Map<string, RatePhaseInput[]>();
  if (contracts.length > 0) {
    const { data: phases, error: phasesError } = await supabase
      .from("contract_rate_phases")
      .select("contract_id, phase_order, duration_months, monthly_rate, end_date")
      .in("contract_id", contracts.map((c) => c.id))
      .returns<PhaseRecord[]>();
    if (phasesError) {
      console.error("[api/leads/value/journey] phases query failed:", phasesError.message);
      return NextResponse.json({ error: "Failed to load journey" }, { status: 500 });
    }
    for (const p of phases ?? []) {
      const list = phasesByContract.get(p.contract_id) ?? [];
      list.push({
        phase_order: p.phase_order,
        duration_months: p.duration_months,
        monthly_rate: Number(p.monthly_rate),
        end_date: p.end_date ?? null,
      });
      phasesByContract.set(p.contract_id, list);
    }
  }

  const journey = buildJourney({
    lead: { created_at: leadRes.data.created_at, source: leadRes.data.source ?? null },
    contracts: contracts.map((c) => ({ ...c, rate_phases: phasesByContract.get(c.id) ?? [] })),
    today: todayYmdIst(),
  });

  return NextResponse.json(
    { journey },
    // Contracts change a few times a month at most; a short private cache keeps
    // sub-tab revisits cheap without ever serving stale data for long.
    { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=120" } }
  );
}
