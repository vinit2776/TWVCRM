// Customer requests: what a message is asking for, who owns it, and how fast it should be
// answered. Pure functions, unit-tested; the DB side is requests-server.ts.

export const REQUEST_TYPES = ["invoice_copy", "access_pass", "add_seats", "renewal_contract", "booking_change"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

export const REQUEST_TYPE_LABEL: Record<RequestType, string> = {
  invoice_copy: "Invoice copy",
  access_pass: "Access / visitor pass",
  add_seats: "Add seats",
  renewal_contract: "Renewal or contract",
  booking_change: "Booking change",
};

/** Who is told, and who a task is pre-assigned to. A person can pick anyone when handling. */
export const REQUEST_OWNER_ROLE: Record<RequestType, string> = {
  invoice_copy: "accounts",
  access_pass: "floor_manager",
  add_seats: "sales_rep",
  renewal_contract: "manager",
  booking_change: "office_admin",
};

export const REQUEST_OWNER_LABEL: Record<RequestType, string> = {
  invoice_copy: "Accounts",
  access_pass: "Floor manager",
  add_seats: "Sales",
  renewal_contract: "Manager",
  booking_change: "Office admin",
};

/** Hours within which the customer should have an answer. */
export const REQUEST_REPLY_TARGET_HOURS: Record<RequestType, number> = {
  invoice_copy: 4,
  access_pass: 2,
  add_seats: 1,
  renewal_contract: 4,
  booking_change: 2,
};

export const REQUEST_TYPE_ORDER: RequestType[] = ["add_seats", "booking_change", "invoice_copy", "access_pass", "renewal_contract"];

const RULES: Record<RequestType, RegExp> = {
  add_seats: /\b(?:(?:more|extra|additional|another)\s+(?:\d+\s+)?(?:seats?|desks?|cabins?|workstations?)|(?:add|need)\s+(?:\d+\s+)?(?:more\s+)?(?:seats?|desks?)\b.*\b(?:more|extra|additional|add)|expand\b|expansion|bigger\s+(?:cabin|office|space)|upgrade\s+(?:our\s+)?(?:cabin|office|plan))/i,
  booking_change: /\b(?:re-?schedul\w*|postpone\w*|(?:change|move|shift|cancel|extend)\s+(?:my|our|the)?\s*(?:booking|reservation|meeting|slot)|(?:booking|reservation|slot)\b.*\b(?:change|move|shift|cancel|extend|another day|different time))/i,
  invoice_copy: /\b(?:invoice|bill|receipt|gst\s*invoice|tax\s*invoice|proforma)\b.*\b(?:copy|send|resend|share|again|forward|need|required|pdf|duplicate)|\b(?:copy|send|resend|share|need|duplicate)\b.*\b(?:invoice|receipt|gst\s*invoice|tax\s*invoice|proforma)/i,
  access_pass: /\b(?:visitor|guest)\s*(?:pass|card|entry|access)|(?:access|id|entry|parking)\s*card|(?:new|lost|replacement|extra)\s*(?:access\s*)?card|wi-?fi\s*(?:password|voucher|code)|(?:pass|voucher)\s*for\s*(?:my|our|a)\s*(?:guest|visitor|client)/i,
  renewal_contract: /\b(?:renew\w*|(?:agreement|contract|lease|lock-?in)\b.*\b(?:end|expir\w*|extend|terminate|notice|copy|clause|change|amend\w*)|(?:end|expir\w*|terminate|notice)\b.*\b(?:agreement|contract|lease))/i,
};

/** Which request a customer message is asking for, or null when it matches none. First match in
 *  REQUEST_TYPE_ORDER wins, so "move my booking" is never mistaken for a contract question. */
export function classifyRequest(text: string): RequestType | null {
  const t = text.trim();
  if (!t) return null;
  return REQUEST_TYPE_ORDER.find((type) => RULES[type].test(t)) ?? null;
}

/** When the reply is due, as plain elapsed time (not business hours). */
export function requestDueAt(type: RequestType, from: Date = new Date()): Date {
  return new Date(from.getTime() + REQUEST_REPLY_TARGET_HOURS[type] * 3_600_000);
}

export function isRequestOverdue(dueAt: string | null, open: boolean, now: Date = new Date()): boolean {
  return open && !!dueAt && Date.parse(dueAt) < now.getTime();
}

export const requestTaskTitle = (type: RequestType, reference: string, customer: string | null) =>
  `${REQUEST_TYPE_LABEL[type]} (${reference})${customer ? `: ${customer}` : ""}`;

/** The default closing message when a request is marked done. */
export const REQUEST_DONE_TEXT: Record<RequestType, string> = {
  invoice_copy: "Your invoice copy has been sent to you.",
  access_pass: "Your pass is arranged. Please collect it at the front desk.",
  add_seats: "We have noted your request for more seats and our team will contact you.",
  renewal_contract: "We have updated you on your contract and will follow up shortly.",
  booking_change: "Your booking has been updated.",
};
