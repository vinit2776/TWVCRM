import { CONTRACT_STATUS_COLORS, CONTRACT_STATUS_LABELS, contractDisplayStatus } from "@/lib/constants";
import { formatDate } from "@/lib/utils";
import type { SearchableSelectOption } from "@/components/ui/searchable-select";

interface UsageContractOption {
  id: string;
  contract_number: string;
  status?: string;
  activated_at?: string | null;
  terminated_at?: string | null;
  end_date?: string | null;
  lead?: { first_name: string; last_name: string; company?: string };
  location?: { name: string };
}

/**
 * Picker option for the usage-logging dialogs. Active contracts stay
 * untagged; anything else gets a colour-coded status badge (with the date a
 * terminated contract ended) so the user bills the right contract.
 */
export function usageContractOption(c: UsageContractOption): SearchableSelectOption {
  const customer = c.lead?.company
    || `${c.lead?.first_name ?? ""} ${c.lead?.last_name ?? ""}`.trim()
    || "Unknown";
  let label = `${c.contract_number} — ${customer}`;
  if (c.location) label += ` · ${c.location.name}`;

  if (!c.status || c.status === "active") return { value: c.id, label };

  const display = contractDisplayStatus({ status: c.status, activated_at: c.activated_at });
  let text = CONTRACT_STATUS_LABELS[display] ?? display;
  const endedOn = c.status === "terminated" ? (c.terminated_at ?? c.end_date) : null;
  if (endedOn) text += ` ${formatDate(endedOn)}`;
  return {
    value: c.id,
    label,
    badge: { text, className: CONTRACT_STATUS_COLORS[display] ?? "bg-gray-100 text-gray-700" },
  };
}
