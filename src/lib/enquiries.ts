import { isPlaceholderName } from "@/lib/whatsapp-names";
import { WORKSPACE_TYPE_LABELS } from "@/lib/constants";

// Shared shape of a public-form enquiry (a `lead_enquiries` row joined to its lead and the
// people who claimed / resolved it). Used by the live-notification hook, the Enquiry Log API
// and the Leads-page tracker so they all read the same fields.

/** What a person can log against an enquiry. `note` covers anything else. */
export const ENQUIRY_UPDATE_KINDS = [
  "call_no_answer",
  "spoke_interested",
  "visit_booked",
  "visit_done",
  "details_sent",
  "waiting_customer",
  "note",
] as const;
export type EnquiryUpdateKind = (typeof ENQUIRY_UPDATE_KINDS)[number];

export const ENQUIRY_UPDATE_LABEL: Record<EnquiryUpdateKind, string> = {
  call_no_answer: "Called, no answer",
  spoke_interested: "Spoke, interested",
  visit_booked: "Visit booked",
  visit_done: "Visit done",
  details_sent: "Sent details on WhatsApp",
  waiting_customer: "Waiting on customer",
  note: "Note",
};

/** Outcomes a person can record when resolving an enquiry. */
export type ResolutionOutcome = "converted" | "not_interested" | "no_response";

/** Everything stored in resolution_outcome. `superseded` is written only by the 00584
 *  backfill (an older enquiry whose real outcome was lost) and is excluded from stats. */
export type EnquiryOutcome = ResolutionOutcome | "superseded" | "spam";

export const ENQUIRY_SOURCE_LABEL: Record<string, string> = {
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  direct_walkin: "Walk-in",
  whatsapp: "WhatsApp",
};

export interface EnquiryItem {
  enquiryId: string;
  leadId: string;
  reference: string;
  name: string;
  mobile: string | null;
  /** Display label, e.g. "Google Ads". */
  source: string;
  /** Raw source key: google_ads | meta_ads | direct_walkin | whatsapp. */
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
  /** What happens next, and the calendar day (IST) it's due. */
  nextStep: string | null;
  followUpAt: string | null;
  /** The latest thing the customer wrote (the last WhatsApp message, or the form's free text). */
  message: string | null;
  /** Every message in the thread, oldest first (a form enquiry has just its free text). */
  messages?: EnquiryMessage[];
  messageCount?: number;
  /** What a form asked for: space type, seats, budget, location, start date. */
  details?: EnquiryDetail[];
  /** How far it has got, read from the lead's proposals and contracts. Absent on live
   *  notification items, which don't carry it. */
  stage?: { key: string; label: string } | null;
  /** Set when the message could not be classified with confidence and a person should confirm
   *  it is a real enquiry (or mark it as spam). Cleared once reviewed. */
  needsReview?: { reason: string } | null;
  /** True while the lead is still called "WhatsApp contact". */
  namePlaceholder?: boolean;
  /** A name the customer gave in their own message, offered for one-tap use. */
  suggestedName?: string | null;
}

export type RawEnquiryRow = {
  id: string;
  reference: string;
  lead_id: string | null;
  source: string;
  is_re_enquiry: boolean;
  payload: {
    name?: string;
    mobile?: string;
    description?: string;
    company?: string;
    workspace_type?: string;
    seat_capacity?: string | number;
    budget_per_seat?: string | number;
    preferred_location?: string;
    working_hours?: string;
    start_date?: string;
    conference_room_location?: string;
    messages?: { at?: string; text?: string }[];
    suggested_name?: string;
    triage?: { kind?: string; reason?: string; source?: string; reviewed?: unknown } | null;
  } | null;
  received_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_at: string | null;
  resolution_outcome: EnquiryOutcome | null;
  next_step?: string | null;
  follow_up_at?: string | null;
  next_step_at?: string | null;
  next_step_by?: string | null;
  stage?: { key: string; label: string } | null;
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
  "next_step, follow_up_at, next_step_at, next_step_by, " +
  "claimer:users!lead_enquiries_claimed_by_fkey(id, full_name), " +
  "resolver:users!lead_enquiries_resolved_by_fkey(id, full_name), " +
  "lead:leads!lead_enquiries_lead_id_fkey(first_name, last_name, mobile, location_id)";

export type EnquiryMessage = { at?: string; text: string };
export type EnquiryDetail = { label: string; value: string };

type EnquiryPayload = RawEnquiryRow["payload"];

/** What the customer wrote, oldest first: the WhatsApp thread, or a form's free text. */
export function enquiryMessages(payload: EnquiryPayload | undefined): EnquiryMessage[] {
  const thread = (payload?.messages ?? [])
    .map((m) => ({ at: m.at, text: (m.text ?? "").trim() }))
    .filter((m) => m.text);
  if (thread.length > 0) return thread;
  const text = payload?.description?.trim();
  return text ? [{ text }] : [];
}

/** What a form asked for, as label / value pairs. Name, mobile and email are left out: they are
 *  already on the lead. Empty for a WhatsApp enquiry, whose request is in its messages. */
export function enquiryDetails(payload: EnquiryPayload | undefined): EnquiryDetail[] {
  if (!payload) return [];
  const out: EnquiryDetail[] = [];
  const add = (label: string, value: unknown) => {
    const v = value == null ? "" : String(value).trim();
    if (v) out.push({ label, value: v });
  };
  add("Looking for", payload.workspace_type ? (WORKSPACE_TYPE_LABELS[payload.workspace_type] ?? payload.workspace_type.replace(/_/g, " ")) : "");
  add("Seats", payload.seat_capacity);
  add("Budget per seat", payload.budget_per_seat ? `₹${payload.budget_per_seat}` : "");
  add("Preferred location", payload.preferred_location);
  add("Conference room", payload.conference_room_location);
  add("Start date", payload.start_date);
  add("Working hours", payload.working_hours);
  add("Company", payload.company);
  return out;
}

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
    nextStep: row.next_step ?? null,
    followUpAt: row.follow_up_at ?? null,
    message: enquiryMessages(row.payload).at(-1)?.text ?? null,
    messages: enquiryMessages(row.payload),
    messageCount: enquiryMessages(row.payload).length,
    details: enquiryDetails(row.payload),
    stage: row.stage ?? null,
    namePlaceholder: isPlaceholderName(row.lead?.first_name),
    suggestedName: row.payload?.suggested_name ?? null,
    needsReview:
      row.payload?.triage?.kind === "unsure" && !row.payload.triage.reviewed
        ? { reason: row.payload.triage.reason ?? "unclear message" }
        : null,
  };
}

/** Today as a YYYY-MM-DD calendar day in IST, the zone follow-up dates are entered in. */
function istDay(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/** Where a follow-up date stands today. Null when there is none. */
export function followUpState(followUpAt: string | null, now: Date = new Date()): "overdue" | "today" | "upcoming" | null {
  if (!followUpAt) return null;
  const due = istDay(new Date(followUpAt));
  const today = istDay(now);
  return due < today ? "overdue" : due === today ? "today" : "upcoming";
}

/** YYYY-MM-DD for an <input type="date"> from a stored follow-up timestamp. */
export function followUpInputValue(followUpAt: string | null): string {
  return followUpAt ? istDay(new Date(followUpAt)) : "";
}

const OUTCOME_LABEL: Record<EnquiryOutcome, string> = {
  converted: "Converted",
  not_interested: "Not interested",
  no_response: "No response",
  superseded: "Superseded",
  spam: "Spam",
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
