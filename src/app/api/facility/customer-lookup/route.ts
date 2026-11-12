/**
 * GET /api/facility/customer-lookup?location_id=<uuid>
 *
 * The customers (live contracts) at a center, with the space units each holds
 * today, for the "Customer" field on the facility report wizard. Read-only.
 * Returns only what the picker needs to recognise a customer: names, contract
 * number and unit names. No rent, deposit or contact details.
 *
 * Auth: any signed-in user (the same people who can log a ticket).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { fetchAllPages, fetchInChunks } from "@/lib/customer-value/query-helpers";
import { todayYmdIst } from "@/lib/customer-value/journey";
import {
  TICKET_CONTRACT_STATUSES,
  buildCustomerOptions,
  type HeldUnit,
  type RawTicketContract,
} from "@/lib/facility/ticket-customer";

export const maxDuration = 30;

const querySchema = z.object({ location_id: z.string().uuid() });

interface AllocationRow {
  id: string;
  contract_id: string;
  space_unit_id: string;
  start_date: string;
  end_date: string | null;
  space_unit: { name: string | null; code: string | null } | null;
}

export async function GET(request: NextRequest) {
  const parsed = querySchema.safeParse({ location_id: new URL(request.url).searchParams.get("location_id") });
  if (!parsed.success) return NextResponse.json({ error: "location_id is required" }, { status: 400 });
  const locationId = parsed.data.location_id;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const contracts = await fetchAllPages<RawTicketContract>("customers", (from, to) =>
      supabase
        .from("contracts")
        .select("id, lead_id, contract_number, lead:leads!contracts_lead_id_fkey(first_name, last_name, company)")
        .eq("location_id", locationId)
        .in("status", [...TICKET_CONTRACT_STATUSES])
        .order("id")
        .range(from, to)
        .returns<RawTicketContract[]>()
    );

    const allocations = await fetchInChunks<AllocationRow>(
      "unit allocations",
      contracts.map((c) => c.id),
      (batch, from, to) =>
        supabase
          .from("contract_space_allocations")
          .select("id, contract_id, space_unit_id, start_date, end_date, space_unit:space_units(name, code)")
          .in("contract_id", batch)
          .order("id")
          .range(from, to)
          .returns<AllocationRow[]>()
    );

    const units: HeldUnit[] = allocations.map((a) => ({
      contract_id: a.contract_id,
      space_unit_id: a.space_unit_id,
      label: a.space_unit?.name || a.space_unit?.code || "Space",
      start_date: a.start_date,
      end_date: a.end_date,
    }));

    return NextResponse.json(
      { data: buildCustomerOptions(contracts, units, todayYmdIst()) },
      { headers: { "Cache-Control": "private, max-age=30" } }
    );
  } catch (err) {
    console.error("[api/facility/customer-lookup] failed:", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "Failed to load customers" }, { status: 500 });
  }
}
