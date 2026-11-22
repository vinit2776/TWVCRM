import { isContractOperational } from "@/lib/constants";

export interface SeenBeforeData {
  lead: { status: string; lost_reason: string | null; junk_reason: string | null; owner_name: string | null };
  earlier: { reference: string; received_at: string }[];
  activities: { type: string; subject: string | null; created_at: string }[];
  proposals: { proposal_number: string | null; status: string }[];
  contracts: { contract_number: string | null; status: string; end_date: string }[];
}

export interface SeenBeforeSummary {
  /** Whether there is anything worth showing: a new customer's first enquiry shows no strip at all. */
  hasHistory: boolean;
  /** A contract that is running now: this is a member calling, not a new sales enquiry. */
  currentCustomer: boolean;
  /** The lead was closed before; a person should know before calling as if it were new. */
  closed: "won" | "lost" | "junk" | null;
  openProposals: number;
}

export function summariseSeenBefore(d: SeenBeforeData): SeenBeforeSummary {
  const live = d.contracts.filter((c) => isContractOperational({ status: c.status, end_date: c.end_date }));
  const openProposals = d.proposals.filter((p) => ["draft", "sent", "viewed"].includes(p.status)).length;
  const closed = d.lead.status === "won" || d.lead.status === "lost" || d.lead.status === "junk" ? d.lead.status : null;
  return {
    hasHistory: d.earlier.length > 0 || d.activities.length > 0 || d.proposals.length > 0 || d.contracts.length > 0 || closed !== null,
    currentCustomer: live.length > 0,
    closed,
    openProposals,
  };
}
