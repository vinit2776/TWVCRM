/**
 * Which center a customer belongs to, and who else belongs to it.
 *
 * Shared by the Compare and Electricity sub-tabs so both mean the same thing as
 * scoring: a customer is ranked at their first location (`primaryLocation`), so a
 * lead whose other contracts sit elsewhere may belong to a different center than
 * one contract suggests.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchInChunks, type PageResult } from "@/lib/customer-value/query-helpers";
import { primaryLocation } from "@/lib/customer-value/scoring-run";

export interface ContractLocation {
  id: string;
  lead_id: string;
  location_id: string | null;
}

export interface CenterCohort {
  centerId: string;
  centerName: string;
  /** Every customer ranked at this center, including this one. */
  leadIds: string[];
  /** This customer's own contracts, all locations. */
  contracts: ContractLocation[];
}

/** Null when the customer has no contract with a location. */
export async function loadCenterCohort(supabase: SupabaseClient, leadId: string): Promise<CenterCohort | null> {
  const { data: mine, error } = await supabase
    .from("contracts")
    .select("id, lead_id, location_id")
    .eq("lead_id", leadId)
    .returns<ContractLocation[]>();
  if (error) throw new Error(error.message);

  const centerId = primaryLocation({ locationIds: (mine ?? []).map((c) => c.location_id).filter((l): l is string => Boolean(l)) });
  if (!centerId) return null;

  const [{ data: location }, atCenter] = await Promise.all([
    supabase.from("locations").select("name").eq("id", centerId).single(),
    fetchInChunks<ContractLocation>("center contracts", [centerId], (batch, from, to): PromiseLike<PageResult<ContractLocation>> =>
      supabase.from("contracts").select("id, lead_id, location_id").in("location_id", batch).order("id").range(from, to)
    ),
  ]);

  const candidateLeads = [...new Set(atCenter.map((c) => c.lead_id))];
  const allContracts = await fetchInChunks<ContractLocation>("candidate contracts", candidateLeads, (batch, from, to) =>
    supabase.from("contracts").select("id, lead_id, location_id").in("lead_id", batch).order("id").range(from, to)
  );
  const locationsByLead = new Map<string, string[]>();
  for (const c of allContracts) {
    if (c.location_id) locationsByLead.set(c.lead_id, [...(locationsByLead.get(c.lead_id) ?? []), c.location_id]);
  }
  const leadIds = candidateLeads.filter((id) => primaryLocation({ locationIds: locationsByLead.get(id) ?? [] }) === centerId);
  if (!leadIds.includes(leadId)) leadIds.push(leadId);

  return { centerId, centerName: (location as { name?: string } | null)?.name ?? "this center", leadIds, contracts: mine ?? [] };
}
