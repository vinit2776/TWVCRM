/**
 * GET /api/analytics/centers/[locationId]/detail?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * One center's drill-down: sales pipeline, receivables aging, room-type
 * occupancy, top clients by billing. Admin only. Backs the Center Analytics
 * drawer.
 *
 * `start`/`end` scope pipeline (proposals sent, contracts signed) and top
 * clients (billed in the period). Aging and room occupancy are current
 * snapshots — chasing a bill or reading today's seat mix "as of last month"
 * isn't a meaningful question, so those ignore the range on purpose.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { balanceDue } from "@/lib/settlement";
import { daysOverdue } from "@/lib/receivables";
import {
  parseDateRange,
  istDayBounds,
  todayIstDate,
  fetchPaymentsTotal,
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

const TOP_CLIENTS_LIMIT = 5;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ locationId: string }> }
) {
  const { locationId } = await params;
  const supabase = await createClient();
  const auth = await requireAdmin(supabase);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let range;
  try {
    range = parseDateRange(request.nextUrl.searchParams);
  } catch (message) {
    return NextResponse.json({ error: String(message) }, { status: 400 });
  }

  const { data: location, error: locErr } = await supabase
    .from("locations").select("id, name").eq("id", locationId).single();
  if (locErr || !location) return NextResponse.json({ error: "Location not found" }, { status: 404 });

  const { data: locationContracts, error: contractsErr } = await supabase
    .from("contracts")
    .select("id, lead_id, total_amount, activated_at")
    .eq("location_id", locationId);
  if (contractsErr) return NextResponse.json({ error: contractsErr.message }, { status: 500 });
  const contractIds = (locationContracts ?? []).map((c) => c.id as string);
  const leadIdByContract = new Map((locationContracts ?? []).map((c) => [c.id as string, c.lead_id as string]));

  const { startIso } = istDayBounds(range.start);
  const { endIso: rangeEndIso } = istDayBounds(range.end);

  // ── Pipeline ───────────────────────────────────────────────────────────
  const [{ count: activeLeads }, { count: proposalsSent }] = await Promise.all([
    supabase.from("leads").select("id", { count: "exact", head: true })
      .eq("location_id", locationId).not("status", "in", "(won,lost)"),
    supabase.from("proposals").select("id", { count: "exact", head: true })
      .eq("location_id", locationId).not("sent_at", "is", null)
      .gte("sent_at", startIso).lte("sent_at", rangeEndIso),
  ]);
  const contractsSignedInRange = (locationContracts ?? []).filter(
    (c) => c.activated_at && c.activated_at >= startIso && c.activated_at <= rangeEndIso
  ).length;

  // ── Aging (current snapshot, not range-bound) ─────────────────────────
  let aging = { not_due: 0, d1_15: 0, d16_30: 0, d31_45: 0, d45_plus: 0 };
  if (contractIds.length > 0) {
    const { data: openStatements, error: agingErr } = await supabase
      .from("billing_statements")
      .select("id, total_amount, due_date")
      .in("contract_id", contractIds)
      .in("status", ["finalized", "exported"])
      .in("payment_status", ["unpaid", "partially_paid"]);
    if (agingErr) return NextResponse.json({ error: agingErr.message }, { status: 500 });

    const paidByStatement = await fetchPaymentsTotal(supabase, (openStatements ?? []).map((s) => s.id as string));
    for (const s of openStatements ?? []) {
      const paid = paidByStatement.get(s.id as string) ?? 0;
      const balance = balanceDue(s.total_amount as number, paid);
      // Same "no due date = not due" treatment as the receivables page.
      const d = s.due_date ? daysOverdue(s.due_date as string) ?? -1 : -1;
      if (d < 0) aging.not_due += balance;
      else if (d <= 15) aging.d1_15 += balance;
      else if (d <= 30) aging.d16_30 += balance;
      else if (d <= 45) aging.d31_45 += balance;
      else aging.d45_plus += balance;
    }
    aging = {
      not_due: Math.round(aging.not_due),
      d1_15: Math.round(aging.d1_15),
      d16_30: Math.round(aging.d16_30),
      d31_45: Math.round(aging.d31_45),
      d45_plus: Math.round(aging.d45_plus),
    };
  }

  // ── Top clients by billing in range ───────────────────────────────────
  let topClients: Array<{ lead_id: string; name: string; billed: number }> = [];
  if (contractIds.length > 0) {
    const { data: rangeStatements, error: rangeErr } = await supabase
      .from("billing_statements")
      .select("contract_id, total_amount")
      .in("contract_id", contractIds)
      .in("status", ["finalized", "exported"])
      .gte("period_start", range.start)
      .lte("period_start", range.end);
    if (rangeErr) return NextResponse.json({ error: rangeErr.message }, { status: 500 });

    const billedByLead = new Map<string, number>();
    for (const s of rangeStatements ?? []) {
      const leadId = leadIdByContract.get(s.contract_id as string);
      if (!leadId) continue;
      billedByLead.set(leadId, (billedByLead.get(leadId) ?? 0) + Number(s.total_amount || 0));
    }
    const topLeadIds = Array.from(billedByLead.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_CLIENTS_LIMIT)
      .map(([leadId]) => leadId);

    if (topLeadIds.length > 0) {
      const { data: leads } = await supabase
        .from("leads").select("id, first_name, last_name, company").in("id", topLeadIds);
      const nameById = new Map((leads ?? []).map((l) => [
        l.id as string,
        (l.company as string) || [l.first_name, l.last_name].filter(Boolean).join(" ") || "(unnamed)",
      ]));
      topClients = topLeadIds.map((leadId) => ({
        lead_id: leadId,
        name: nameById.get(leadId) ?? "(unknown)",
        billed: Math.round(billedByLead.get(leadId) ?? 0),
      }));
    }
  }

  // ── Room-type occupancy (current, includes business_centre — unlike the
  //    summary/trend occupancy_pct, this is a full room-mix breakdown) ────
  const [{ data: units, error: unitsErr }, { data: occupants, error: occErr }] = await Promise.all([
    supabase.from("space_units").select("id, type, capacity").eq("location_id", locationId).eq("is_active", true),
    supabase.from("space_seat_occupants").select("id, space_unit_id, start_date, end_date").eq("location_id", locationId),
  ]);
  if (unitsErr) return NextResponse.json({ error: unitsErr.message }, { status: 500 });
  if (occErr) return NextResponse.json({ error: occErr.message }, { status: 500 });

  const today = todayIstDate();
  const unitTypeById = new Map((units ?? []).map((u) => [u.id as string, u.type as string]));
  const capacityByType = new Map<string, number>();
  for (const u of units ?? []) {
    const t = u.type as string;
    capacityByType.set(t, (capacityByType.get(t) ?? 0) + Number(u.capacity || 0));
  }
  const occupiedByType = new Map<string, number>();
  for (const o of occupants ?? []) {
    const isActive = (o.start_date as string) <= today && (!o.end_date || (o.end_date as string) >= today);
    if (!isActive) continue;
    const t = unitTypeById.get(o.space_unit_id as string);
    if (!t) continue;
    occupiedByType.set(t, (occupiedByType.get(t) ?? 0) + 1);
  }
  const rooms = Array.from(capacityByType.entries()).map(([type, capacity]) => ({
    type,
    capacity,
    occupied: Math.min(occupiedByType.get(type) ?? 0, capacity),
  }));

  return NextResponse.json({
    data: {
      location: { id: location.id, name: location.name },
      range,
      pipeline: {
        active_leads: activeLeads ?? 0,
        proposals_sent: proposalsSent ?? 0,
        contracts_signed: contractsSignedInRange,
      },
      aging,
      rooms,
      top_clients: topClients,
    },
  });
}
