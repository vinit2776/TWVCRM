/**
 * Which center a customer belongs to, and who else belongs to it.
 *
 * Two meanings, kept apart on purpose:
 *  - "primary" (the default): what scoring means. A customer is ranked at their
 *    first location (`primaryLocation`, lowest id), so Compare matches the score.
 *  - "live": where the customer is actually served now (`chooseServiceCenter`).
 *    The money tabs (Electricity, Costs, Wi-Fi) and the nightly margin job use it,
 *    because a customer with contracts at two centers is served, and costs us
 *    electricity and rent, at the one where they hold live seats, not at whichever
 *    center's id sorts first.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchInChunks, type PageResult } from "@/lib/customer-value/query-helpers";
import { primaryLocation } from "@/lib/customer-value/scoring-run";

export interface ContractLocation {
  id: string;
  lead_id: string;
  location_id: string | null;
  status?: string | null;
  seats?: number | string | null;
  start_date?: string | null;
  activated_at?: string | null;
}

const COLUMNS = "id, lead_id, location_id, status, seats, start_date, activated_at";
const LIVE_STATUSES = ["active", "renewal_in_progress"];

/**
 * The center a customer is served at: the one where their live contracts hold the
 * most seats (ties go to the later start, then the lower id), else the center of
 * the contract that last actually ran (activated), else their first location.
 * Contracts that never activated (drafts, withdrawn) never decide it.
 */
export function chooseServiceCenter(contracts: ContractLocation[]): string | null {
  const withCenter = contracts.filter((c): c is ContractLocation & { location_id: string } => Boolean(c.location_id));
  const live = withCenter.filter((c) => LIVE_STATUSES.includes(c.status ?? ""));
  if (live.length > 0) {
    const seats = new Map<string, { seats: number; start: string }>();
    for (const c of live) {
      const cur = seats.get(c.location_id) ?? { seats: 0, start: "" };
      cur.seats += Number(c.seats) || 0;
      if ((c.start_date ?? "") > cur.start) cur.start = c.start_date ?? "";
      seats.set(c.location_id, cur);
    }
    return [...seats.entries()].sort((a, b) => b[1].seats - a[1].seats || (a[1].start < b[1].start ? 1 : a[1].start > b[1].start ? -1 : 0) || (a[0] < b[0] ? -1 : 1))[0][0];
  }
  const ran = withCenter.filter((c) => Boolean(c.activated_at)).sort((a, b) => ((a.start_date ?? "") < (b.start_date ?? "") ? 1 : -1));
  if (ran.length > 0) return ran[0].location_id;
  return primaryLocation({ locationIds: withCenter.map((c) => c.location_id) });
}

export interface CenterCohort {
  centerId: string;
  centerName: string;
  /** Every customer ranked at this center, including this one. */
  leadIds: string[];
  /** This customer's own contracts, all locations. */
  contracts: ContractLocation[];
}

export type CenterMeaning = "primary" | "live";

/** Null when the customer has no contract with a location. */
export async function loadCenterCohort(supabase: SupabaseClient, leadId: string, meaning: CenterMeaning = "primary"): Promise<CenterCohort | null> {
  const { data: mine, error } = await supabase
    .from("contracts")
    .select(COLUMNS)
    .eq("lead_id", leadId)
    .returns<ContractLocation[]>();
  if (error) throw new Error(error.message);

  const centerOf = (contracts: ContractLocation[]) =>
    meaning === "live" ? chooseServiceCenter(contracts) : primaryLocation({ locationIds: contracts.map((c) => c.location_id).filter((l): l is string => Boolean(l)) });
  const centerId = centerOf(mine ?? []);
  if (!centerId) return null;

  const [{ data: location }, atCenter] = await Promise.all([
    supabase.from("locations").select("name").eq("id", centerId).single(),
    fetchInChunks<ContractLocation>("center contracts", [centerId], (batch, from, to): PromiseLike<PageResult<ContractLocation>> =>
      supabase.from("contracts").select(COLUMNS).in("location_id", batch).order("id").range(from, to)
    ),
  ]);

  const candidateLeads = [...new Set(atCenter.map((c) => c.lead_id))];
  const allContracts = await fetchInChunks<ContractLocation>("candidate contracts", candidateLeads, (batch, from, to) =>
    supabase.from("contracts").select(COLUMNS).in("lead_id", batch).order("id").range(from, to)
  );
  const contractsByLead = new Map<string, ContractLocation[]>();
  for (const c of allContracts) contractsByLead.set(c.lead_id, [...(contractsByLead.get(c.lead_id) ?? []), c]);
  const leadIds = candidateLeads.filter((id) => centerOf(contractsByLead.get(id) ?? []) === centerId);
  if (!leadIds.includes(leadId)) leadIds.push(leadId);

  return { centerId, centerName: (location as { name?: string } | null)?.name ?? "this center", leadIds, contracts: mine ?? [] };
}
