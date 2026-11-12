import type { SupabaseClient } from "@supabase/supabase-js";

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
