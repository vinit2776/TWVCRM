/**
 * Whether an enquiry's own words contain what someone searched for: what the customer wrote
 * (the form's description, every WhatsApp message), the area they asked for and the space type.
 * Used by the Leads search so "cabin", "Anna Salai" or "MD cabin" finds the lead behind an enquiry,
 * not just a name or number.
 */
export interface EnquirySearchPayload {
  description?: string | null;
  preferred_location?: string | null;
  workspace_type?: string | null;
  messages?: { text?: string | null }[] | null;
}

export const ENQUIRY_SEARCH_MIN_CHARS = 3;

export function enquiryTextMatches(payload: EnquirySearchPayload | null | undefined, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle.length < ENQUIRY_SEARCH_MIN_CHARS || !payload) return false;
  const parts = [payload.description, payload.preferred_location, payload.workspace_type, ...(payload.messages ?? []).map((m) => m?.text)];
  return parts.filter((p): p is string => typeof p === "string" && p !== "").join(" ").toLowerCase().includes(needle);
}
