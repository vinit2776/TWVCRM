/**
 * Loads a lead's contracts, with their rate phases, in the shape the Value tab
 * calculations expect. Shared by the Journey and Money routes so both read the
 * contract chain the same way. Read-only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { JourneyContractRow } from "@/lib/customer-value/journey";
import type { RatePhaseInput } from "@/lib/rate-phase-dates";

const CONTRACT_COLUMNS =
  "id, contract_number, status, start_date, end_date, activated_at, terminated_at, seats, subtotal, " +
  "escalation_percentage, escalation_waived, escalation_approval_status, parent_contract_id, " +
  "renewal_sequence, days_extended, phase_start_date, renewal_declined";

type ContractRecord = Omit<JourneyContractRow, "rate_phases">;
type PhaseRecord = RatePhaseInput & { contract_id: string };

export async function loadLeadContracts(
  supabase: SupabaseClient,
  leadId: string
): Promise<{ contracts: JourneyContractRow[] } | { error: string }> {
  const { data, error } = await supabase
    .from("contracts")
    .select(CONTRACT_COLUMNS)
    .eq("lead_id", leadId)
    .returns<ContractRecord[]>();
  if (error) return { error: error.message };

  const records = data ?? [];
  const phasesByContract = new Map<string, RatePhaseInput[]>();
  if (records.length > 0) {
    const { data: phases, error: phasesError } = await supabase
      .from("contract_rate_phases")
      .select("contract_id, phase_order, duration_months, monthly_rate, end_date")
      .in("contract_id", records.map((c) => c.id))
      .returns<PhaseRecord[]>();
    if (phasesError) return { error: phasesError.message };

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

  return {
    contracts: records.map((c) => ({ ...c, rate_phases: phasesByContract.get(c.id) ?? [] })),
  };
}
