// How an inbound WhatsApp message is described in the Inbound WhatsApp log. The intake stores a
// fine-grained outcome on each message (migration 00728); the log groups those into the few
// things a person actually asks: was it a first enquiry, a follow-up, a repeat, junk, held, ignored.

export const INBOUND_GROUPS = ["new", "re_enquiry", "follow_up", "junk", "held", "ignored", "other", "untracked"] as const;
export type InboundGroup = (typeof INBOUND_GROUPS)[number];

export const INBOUND_GROUP_LABEL: Record<InboundGroup, string> = {
  new: "First enquiry",
  re_enquiry: "Re-enquiry",
  follow_up: "Follow-up",
  junk: "Junk",
  held: "Held for review",
  ignored: "Ignored",
  other: "Other",
  untracked: "Before tracking",
};

/** Which group a stored intake outcome belongs to. A message with no outcome predates tracking. */
export function inboundGroupOf(outcome: string | null | undefined): InboundGroup {
  switch (outcome) {
    case "new_lead":
      return "new";
    case "re_enquiry":
      return "re_enquiry";
    case "joined_open_enquiry":
      return "follow_up";
    case "spam_stashed":
      return "junk";
    case "held_for_review":
      return "held";
    case "labelled_ignored":
      return "ignored";
    case "logged_only":
    case "request_recorded":
    case "not_processed":
    case "intake_error":
      return "other";
    default:
      return "untracked";
  }
}

/** The line under the label: where the message went, in words. */
export function inboundOutcomeDetail(outcome: string | null | undefined, reference: string | null): string {
  switch (outcome) {
    case "new_lead":
    case "re_enquiry":
      return reference ? `New card ${reference}` : "New enquiry card";
    case "joined_open_enquiry":
      return reference ? `Added to ${reference}` : "Added to the open enquiry";
    case "spam_stashed":
      return "In Spam, restorable";
    case "held_for_review":
      return "In the Possible leads tray";
    case "labelled_ignored":
      return "Number is labelled, no enquiry opened";
    case "logged_only":
      return "A customer message, not an enquiry";
    case "request_recorded":
      return reference ? `Customer request ${reference}` : "Customer request recorded";
    case "not_processed":
      return "Not processed (own number or unreadable)";
    case "intake_error":
      return "The CRM failed to process this, check the logs";
    default:
      return "Saved before outcomes were recorded";
  }
}

/** Outcomes behind each group, for filtering at the database. `untracked` is NULL. */
export const GROUP_OUTCOMES: Record<Exclude<InboundGroup, "untracked">, string[]> = {
  new: ["new_lead"],
  re_enquiry: ["re_enquiry"],
  follow_up: ["joined_open_enquiry"],
  junk: ["spam_stashed"],
  held: ["held_for_review"],
  ignored: ["labelled_ignored"],
  other: ["logged_only", "request_recorded", "not_processed", "intake_error"],
};

// The website's prefilled WhatsApp messages. A message that opens with one of these is the trigger
// for the Inbound WhatsApp log; everything else on the number is left out of it by default.
// Keep in step with the website's wa.me links.
export type WebsiteTrigger = "book_tour" | "know_more" | "centre_tour" | "workspace_finder" | "enquiry_form";

export const WEBSITE_TRIGGER_LABEL: Record<WebsiteTrigger, string> = {
  book_tour: "Book a tour",
  know_more: "Know more (WhatsApp button)",
  centre_tour: "Centre tour",
  workspace_finder: "Workspace finder",
  enquiry_form: "Enquiry form",
};

/** Which website button sent this message, or null when it is not one of the prefilled texts. */
export function websiteTriggerOf(text: string | null | undefined): WebsiteTrigger | null {
  if (!text) return null;
  const t = text.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  const HEAD = "hi workvilla, ";
  if (!t.startsWith(HEAD)) return null;
  const rest = t.slice(HEAD.length).replace(/[.!]+$/, "");
  if (rest === "i'd like to book a tour") return "book_tour";
  if (rest === "i'd like to know more about your workspaces") return "know_more";
  if (rest.startsWith("i'd like to book a tour of your")) return "centre_tour";
  if (rest.startsWith("i'm looking for a")) return "workspace_finder";
  if (rest.startsWith("i'm") && rest.includes("interested in:")) return "enquiry_form";
  return null;
}
