import { CONTRACT_STATUS_LABELS, contractDisplayStatus } from "@/lib/constants";
import { formatDate } from "@/lib/utils";

interface UsageContractOption {
  contract_number: string;
  status?: string;
  activated_at?: string | null;
  terminated_at?: string | null;
  end_date?: string | null;
  lead?: { first_name: string; last_name: string; company?: string };
  location?: { name: string };
}

/**
 * Label for the contract pickers in the usage-logging dialogs. Active
 * contracts stay untagged; anything else gets its status (and the date a
 * terminated contract ended) so the user bills the right contract.
 */
export function usageContractLabel(c: UsageContractOption): string {
  const customer = c.lead?.company
    || `${c.lead?.first_name ?? ""} ${c.lead?.last_name ?? ""}`.trim()
    || "Unknown";
  const parts = [`${c.contract_number} — ${customer}`];
  if (c.location) parts[0] += ` · ${c.location.name}`;

  if (c.status && c.status !== "active") {
    const display = contractDisplayStatus({ status: c.status, activated_at: c.activated_at });
    let tag = CONTRACT_STATUS_LABELS[display] ?? display;
    const endedOn = c.status === "terminated" ? (c.terminated_at ?? c.end_date) : null;
    if (endedOn) tag += ` ${formatDate(endedOn)}`;
    parts.push(tag);
  }
  return parts.join(" · ");
}
