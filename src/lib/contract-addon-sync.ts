import type { SupabaseClient } from "@supabase/supabase-js";
import { followTermDates, type TermDates } from "@/lib/recurring-addons";

/**
 * When a contract's start or end date moves, the add-ons still on the default
 * (full-term) dates move with it; ones edited for the customer stay as they
 * are. Failures are logged, not thrown: the date change itself has already
 * been saved and must not be reported as failed.
 */
export async function syncAddonsToContractTerm(
  admin: SupabaseClient,
  contractId: string,
  from: TermDates,
  to: TermDates
): Promise<void> {
  if (from.start === to.start && from.end === to.end) return;
  try {
    const { data: addons, error } = await admin
      .from("contract_addons")
      .select("id, effective_from, effective_until")
      .eq("contract_id", contractId);
    if (error) throw new Error(error.message);

    for (const addon of addons ?? []) {
      const next = followTermDates(
        { effective_from: addon.effective_from as string, effective_until: (addon.effective_until as string | null) ?? null },
        from,
        to
      );
      if (!next) continue;
      const { error: updateError } = await admin
        .from("contract_addons")
        .update({ ...next, updated_at: new Date().toISOString() })
        .eq("id", addon.id);
      if (updateError) throw new Error(updateError.message);
    }
  } catch (err) {
    console.error("[contract-addons] Failed to follow the contract term:", err instanceof Error ? err.message : err);
  }
}
