/**
 * GET /api/analytics/centers/projections?fy=2026
 *
 * Projects pre-GST monthly recurring revenue across a financial year (Apr-Mar)
 * from contracts already on file — no new bookings assumed. Admin only.
 *
 * `fy` is the FY's start year and must be either the current FY or the next
 * one (the only two horizons the UI offers a toggle for) — reject anything
 * else rather than silently projecting an arbitrary year.
 *
 * Two figures per month, per location:
 *  - confirmed: active/renewal_in_progress contracts overlapping that month,
 *    at their current phase rate. Stops dead at each contract's end_date —
 *    no renewal assumed.
 *  - if_renewed: hypothetical — for a contract that has already ended by
 *    that month, one month of revenue at its last-charged rate x
 *    (1 + its own escalation_percentage/100), as if it renewed on schedule.
 *    Applied once per contract, not compounded per month.
 *
 * Also returns a flat contract-level list (rate, end date, escalation %,
 * hypothetical renewed rate) so the UI can drill into what's driving the
 * numbers — same shape regardless of which FY was requested, since a
 * contract's own fields don't change with the horizon.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  todayIstDate,
  currentFyYear,
  fyLabel,
  fetchProjectionContracts,
  fetchRatePhasesByContract,
  computeProjection,
  buildProjectionContractDetails,
} from "@/lib/analytics/center-metrics";

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };
  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || dbUser.role !== "admin") {
    return { error: "Admin access required", status: 403 as const };
  }
  return { error: null, status: 200 as const };
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const today = todayIstDate();
  const thisFy = currentFyYear(today);
  const nextFy = thisFy + 1;

  const fyParam = request.nextUrl.searchParams.get("fy");
  const fyYear = fyParam ? Number(fyParam) : thisFy;
  if (!Number.isInteger(fyYear) || (fyYear !== thisFy && fyYear !== nextFy)) {
    return NextResponse.json(
      { error: `fy must be ${thisFy} (current) or ${nextFy} (next)` },
      { status: 400 }
    );
  }

  const { data: locations, error: locErr } = await supabase
    .from("locations").select("id, name").eq("is_active", true);
  if (locErr) return NextResponse.json({ error: locErr.message }, { status: 500 });
  const locationNameById = new Map((locations ?? []).map((l) => [l.id as string, l.name as string]));

  let contracts;
  try {
    contracts = await fetchProjectionContracts(supabase);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  let ratePhasesByContract;
  try {
    ratePhasesByContract = await fetchRatePhasesByContract(
      supabase,
      contracts.map((c) => c.id)
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  const leadIds = Array.from(new Set(contracts.map((c) => c.lead_id).filter(Boolean)));
  const clientNameByLeadId = new Map<string, string>();
  if (leadIds.length > 0) {
    const { data: leads, error: leadErr } = await supabase
      .from("leads").select("id, first_name, last_name, company").in("id", leadIds);
    if (leadErr) return NextResponse.json({ error: leadErr.message }, { status: 500 });
    for (const l of leads ?? []) {
      const name = (l.company as string) || [l.first_name, l.last_name].filter(Boolean).join(" ") || "(unnamed)";
      clientNameByLeadId.set(l.id as string, name);
    }
  }

  const { months, centers } = computeProjection(contracts, ratePhasesByContract, fyYear);
  const contractDetails = buildProjectionContractDetails(contracts, ratePhasesByContract, clientNameByLeadId, today);

  return NextResponse.json({
    data: {
      fy: {
        year: fyYear,
        label: fyLabel(fyYear),
        is_current: fyYear === thisFy,
        start: `${fyYear}-04-01`,
        end: `${fyYear + 1}-03-31`,
      },
      months,
      centers: centers.map((c) => ({ ...c, location_name: locationNameById.get(c.location_id) ?? "Unknown" })),
      contracts: contractDetails.map((c) => ({
        ...c,
        location_name: locationNameById.get(c.location_id) ?? "Unknown",
      })),
    },
  });
}
