import type { SupabaseClient } from "@supabase/supabase-js";
import { isContractOperational } from "@/lib/constants";

export interface LiveContract {
  id: string;
  contract_number: string;
  status: string;
  end_date: string;
}

export type AttachDecision =
  | { kind: "attach"; contractId: string }
  | { kind: "none" }
  | { kind: "choose" }
  | { kind: "invalid" };

/**
 * Decides which contract an ad-hoc invoice belongs on when it is created.
 * A live contract captures all of the customer's financial activity, so one
 * live contract attaches by itself; several must be chosen by the person
 * raising it (never guessed); none means the invoice stays on the ad-hoc
 * page only.
 */
export function decideAttachment(
  liveContracts: LiveContract[],
  requestedContractId?: string | null,
  // Whether the requested contract belongs to the same customer. It need not
  // be live: the contract page's Invoice wizard also raises the pro-rata
  // invoice for a contract that is not active yet.
  requestedBelongsToCustomer = false,
): AttachDecision {
  if (requestedContractId) {
    return requestedBelongsToCustomer || liveContracts.some((c) => c.id === requestedContractId)
      ? { kind: "attach", contractId: requestedContractId }
      : { kind: "invalid" };
  }
  if (liveContracts.length === 0) return { kind: "none" };
  if (liveContracts.length === 1) return { kind: "attach", contractId: liveContracts[0].id };
  return { kind: "choose" };
}

export async function loadLiveContracts(
  supabase: SupabaseClient,
  leadId: string,
): Promise<LiveContract[]> {
  const { data } = await supabase
    .from("contracts")
    .select("id, contract_number, status, end_date")
    .eq("lead_id", leadId)
    .in("status", ["active", "renewal_in_progress"]);
  return ((data ?? []) as LiveContract[]).filter(isContractOperational);
}

export async function contractBelongsToLead(
  supabase: SupabaseClient,
  contractId: string,
  leadId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("contracts")
    .select("id")
    .eq("id", contractId)
    .eq("lead_id", leadId)
    .maybeSingle();
  return !!data;
}

/** Purpose written on an automatic attachment. Visibility only: it can never
 *  unblock contract activation (only 'prorata_first_invoice' does that). */
export const AUTO_ATTRIBUTION_PURPOSE = "other" as const;
