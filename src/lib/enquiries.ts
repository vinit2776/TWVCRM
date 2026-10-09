// Shared shape of a public-form enquiry (a `lead_enquiries` row joined to its lead and the
// people who claimed / resolved it). Used by the live-notification hook, the Enquiry Log API
// and the Leads-page tracker so they all read the same fields.

/** Outcomes a person can record when resolving an enquiry. */
export type ResolutionOutcome = "converted" | "not_interested" | "no_response";

/** Everything stored in resolution_outcome. `superseded` is written only by the 00584
 *  backfill (an older enquiry whose real outcome was lost) and is excluded from stats. */
export type EnquiryOutcome = ResolutionOutcome | "superseded";

export const ENQUIRY_SOURCE_LABEL: Record<string, string> = {
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  direct_walkin: "Walk-in",
};

export interface EnquiryItem {
  enquiryId: string;
  leadId: string;
  reference: string;
  name: string;
  mobile: string | null;
  /** Display label, e.g. "Google Ads". */
  source: string;
  /** Raw source key: google_ads | meta_ads | direct_walkin. */
  sourceTag: string;
  /** When this enquiry was received. */
  attentionResetAt: string;
  createdAt: string;
  isReEnquiry: boolean;
  claimedBy: string | null;
  claimedAt: string | null;
  claimerName: string | null;
  resolverName: string | null;
  resolvedAt: string | null;
  resolutionOutcome: EnquiryOutcome | null;
}

export type RawEnquiryRow = {
  id: string;
  reference: string;
  lead_id: string | null;
  source: string;
  is_re_enquiry: boolean;
  payload: { name?: string; mobile?: string } | null;
  received_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_at: string | null;
  resolution_outcome: EnquiryOutcome | null;
  claimer?: { id: string; full_name: string } | null;
  resolver?: { id: string; full_name: string } | null;
  lead?: {
    first_name: string | null;
    last_name: string | null;
    mobile: string | null;
    location_id?: string | null;
  } | null;
};

export const ENQUIRY_SELECT =
  "id, reference, lead_id, source, is_re_enquiry, payload, received_at, " +
  "claimed_by, claimed_at, resolved_at, resolution_outcome, " +
  "claimer:users!lead_enquiries_claimed_by_fkey(id, full_name), " +
  "resolver:users!lead_enquiries_resolved_by_fkey(id, full_name), " +
  "lead:leads!lead_enquiries_lead_id_fkey(first_name, last_name, mobile, location_id)";

/** Null for an enquiry whose lead was deleted — there's nothing to open or act on. */
export function toEnquiryItem(row: RawEnquiryRow): EnquiryItem | null {
  if (!row.lead_id) return null;
  const leadName = `${row.lead?.first_name ?? ""} ${row.lead?.last_name ?? ""}`.trim();
  return {
    enquiryId: row.id,
    leadId: row.lead_id,
    reference: row.reference,
    name: leadName || row.payload?.name || "Unknown",
    mobile: row.lead?.mobile ?? row.payload?.mobile ?? null,
    source: ENQUIRY_SOURCE_LABEL[row.source] ?? row.source,
    sourceTag: row.source,
    attentionResetAt: row.received_at,
    createdAt: row.received_at,
    isReEnquiry: row.is_re_enquiry,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    claimerName: row.claimer?.full_name ?? null,
    resolverName: row.resolver?.full_name ?? null,
    resolvedAt: row.resolved_at,
    resolutionOutcome: row.resolution_outcome,
  };
}

const OUTCOME_LABEL: Record<EnquiryOutcome, string> = {
  converted: "Converted",
  not_interested: "Not interested",
  no_response: "No response",
  superseded: "Superseded",
};

export function enquiryOutcomeLabel(outcome: EnquiryOutcome): string {
  return OUTCOME_LABEL[outcome];
}

/** One-line state of an enquiry for lists: "Open", "Claimed · Asha", "Converted · Vignesh". */
export function enquiryStateLabel(e: {
  claimerName: string | null;
  claimedAt: string | null;
  resolvedAt: string | null;
  resolutionOutcome: EnquiryOutcome | null;
  resolverName: string | null;
}): string {
  if (e.resolvedAt) {
    const outcome = e.resolutionOutcome ? OUTCOME_LABEL[e.resolutionOutcome] : "Resolved";
    return e.resolverName && e.resolutionOutcome !== "superseded"
      ? `${outcome} · ${e.resolverName}`
      : outcome;
  }
  if (e.claimedAt) return `Claimed · ${e.claimerName ?? "someone"}`;
  return "Open";
}
