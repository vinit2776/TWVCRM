// The lead gate for the connected WhatsApp number: who is writing decides first, what they
// wrote decides second. Pure helpers, unit-tested; the database work lives in whatsapp-intake.ts.

import type { TriageKind } from "@/lib/whatsapp-triage";

export const NUMBER_LABELS = ["staff", "vendor", "customer_team", "not_lead"] as const;
export type NumberLabel = (typeof NUMBER_LABELS)[number];

export const NUMBER_LABEL_TEXT: Record<NumberLabel, string> = {
  staff: "Company staff",
  vendor: "Vendor / service provider",
  customer_team: "Customer's team member",
  not_lead: "Not a lead (other)",
};

export function isNumberLabel(v: unknown): v is NumberLabel {
  return typeof v === "string" && (NUMBER_LABELS as readonly string[]).includes(v);
}

/** Labels whose messages are stored but never open an enquiry. */
export function labelSilencesNumber(label: string | null | undefined): boolean {
  return label === "staff" || label === "vendor" || label === "not_lead";
}

/** A customer's team member is a contact of that customer: whatever they write is customer
 *  traffic (complaints still reach the complaint lane), never a new enquiry. */
export function applyLabelToKind(label: string | null | undefined, kind: TriageKind): TriageKind {
  if (label !== "customer_team") return kind;
  return kind === "complaint" || kind === "customer" ? kind : "customer";
}

/** Held in the Possible leads tray (no lead, no enquiry yet): an unknown number whose message the
 *  rules could not judge. A known number keeps today's path (an enquiry flagged Needs review),
 *  and an ad reply is never held. */
export function shouldHoldForReview(a: { kind: TriageKind; knownSender: boolean; hasReferral: boolean }): boolean {
  return a.kind === "unsure" && !a.knownSender && !a.hasReferral;
}

/** Last 10 digits, the key labels and held conversations use. */
export function last10Of(raw: string): string {
  return raw.replace(/\D/g, "").slice(-10);
}
