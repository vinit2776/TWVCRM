import type { SupabaseClient } from "@supabase/supabase-js";
import type { RentCoverage } from "@/lib/billing-months";

/** Guard against a cycle in parent_contract_id turning this into an infinite walk. */
const MAX_CHAIN_DEPTH = 20;

/**
 * A contract plus every ancestor it was renewed from, nearest first.
 *
 * Renewal billing is not confined to one contract row. While a parent is
 * `renewal_in_progress` and its renewal has not been activated, the parent is
 * the only billable contract, so the month-end run charges it for days past its
 * own end_date at the renewal's rate. Any question of the form "has this
 * contract been billed for month X" therefore has to be asked of the whole
 * chain — asked of one row it reports months as unbilled that were invoiced and
 * paid under the previous contract number.
 *
 * Returns [contractId] when there is no parent, so callers need no special case.
 */
export async function renewalChainContractIds(
  supabase: SupabaseClient,
  contractId: string,
): Promise<string[]> {
  const chain: string[] = [contractId];
  const seen = new Set<string>([contractId]);
  let cursor: string | null = contractId;

  for (let depth = 0; depth < MAX_CHAIN_DEPTH && cursor; depth++) {
    const { data } = (await supabase
      .from("contracts")
      .select("parent_contract_id")
      .eq("id", cursor)
      .maybeSingle()) as { data: { parent_contract_id: string | null } | null };

    const parent: string | null = data?.parent_contract_id ?? null;
    if (!parent || seen.has(parent)) break;

    chain.push(parent);
    seen.add(parent);
    cursor = parent;
  }

  return chain;
}

/**
 * The rent a proposal collected before its contract existed, as coverage rows
 * keyed by proposal id.
 *
 * The proposal's pro-rata invoice is a rent statement owned by the proposal
 * (contract_id null) — nothing re-points it at the contract on activation. For
 * a contract starting on the 1st it is the whole start month's rent, so a gap
 * check that only reads contract-owned statements reports that month as
 * unbilled (TWV-C-0160, Nov 2026) and "Bill this month" would invoice it twice.
 *
 * Voided, discarded and cancelled invoices are left out: nothing was collected.
 */
export async function fetchProrataCoverageByProposal(
  supabase: SupabaseClient,
  proposalIds: string[],
): Promise<Map<string, RentCoverage[]>> {
  const out = new Map<string, RentCoverage[]>();
  const ids = [...new Set(proposalIds.filter(Boolean))];
  if (ids.length === 0) return out;

  const { data } = await supabase
    .from("billing_statements")
    .select("proposal_id, statement_type, period_start, period_end, prepaid_month, prepaid_year, voided_at")
    .in("proposal_id", ids)
    .is("contract_id", null)
    .is("voided_at", null)
    .is("pi_cancelled_at", null)
    .neq("status", "discarded");

  for (const row of (data ?? []) as Array<RentCoverage & { proposal_id: string }>) {
    const list = out.get(row.proposal_id) ?? [];
    list.push(row);
    out.set(row.proposal_id, list);
  }
  return out;
}
