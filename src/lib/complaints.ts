// Pure rules for customer complaints (see migration 00622). The DB side is complaints-server.ts.

import type { FacilityIssuePriority } from "@/types";

export const COMPLAINT_STATUSES = ["new", "needs_info", "qualified", "not_a_complaint", "closed"] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export const COMPLAINT_OUTCOMES = ["work_order", "task", "reply_only", "enquiry"] as const;
export type ComplaintOutcome = (typeof COMPLAINT_OUTCOMES)[number];

export const COMPLAINT_STATUS_LABEL: Record<ComplaintStatus, string> = {
  new: "New",
  needs_info: "Needs info",
  qualified: "Work order raised",
  not_a_complaint: "Not a complaint",
  closed: "Closed",
};

/** The same statuses read differently for a request. */
export const REQUEST_STATUS_LABEL: Record<ComplaintStatus, string> = {
  new: "New",
  needs_info: "Needs info",
  qualified: "Task raised",
  not_a_complaint: "Not a request",
  closed: "Done",
};

export const COMPLAINT_OUTCOME_LABEL: Record<ComplaintOutcome, string> = {
  work_order: "Work order",
  task: "Task (internal follow-up)",
  reply_only: "Reply only, no action",
  enquiry: "Converted to an enquiry",
};

/** Complaints from the same customer within this many days count as repeats. */
export const REPEAT_WINDOW_DAYS = 30;
/** A further message about a still-open complaint joins it for this long. */
export const OPEN_COMPLAINT_WINDOW_DAYS = 14;

const PRIORITY_ORDER: FacilityIssuePriority[] = ["low", "medium", "high", "critical"];

/** Suggested priority: a repeat complaint (two or more earlier) is at least high; safety or
 *  outage wording from the facility classifier can only raise it, never lower it. */
export function suggestComplaintPriority(repeatCount: number, floor?: FacilityIssuePriority): FacilityIssuePriority {
  const base: FacilityIssuePriority = repeatCount >= 2 ? "high" : "medium";
  if (!floor) return base;
  return PRIORITY_ORDER.indexOf(floor) > PRIORITY_ORDER.indexOf(base) ? floor : base;
}

/** Whether a complaint still needs someone's attention. A qualified complaint is open until
 *  its work order is resolved or closed, so there is no second status to keep in step. */
export function effectiveComplaintStatus(
  status: ComplaintStatus,
  issueStatus: string | null,
  taskStatus: string | null = null
): ComplaintStatus {
  if (status === "qualified" && (issueStatus === "resolved" || issueStatus === "closed")) return "closed";
  // A request handled by a task closes when the task is done.
  if (status === "qualified" && taskStatus === "done") return "closed";
  return status;
}

export const isOpenComplaint = (status: ComplaintStatus) =>
  status === "new" || status === "needs_info" || status === "qualified";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function buildWorkOrderTitle(firstMessage: string): string {
  return `Customer complaint: ${clip(firstMessage.replace(/\s+/g, " ").trim(), 70)}`;
}

export function buildWorkOrderDescription(input: {
  reference: string;
  messages: { at?: string; text?: string }[];
  customerName: string | null;
  contractNumber: string | null;
}): string {
  const lines = [
    `Raised from customer complaint ${input.reference} (WhatsApp).`,
    input.customerName ? `Customer: ${input.customerName}${input.contractNumber ? ` (${input.contractNumber})` : ""}` : null,
    "",
    "Customer wrote:",
    ...input.messages.map((m) => `- ${(m.text ?? "").trim()}`),
  ];
  return lines.filter((l) => l !== null).join("\n");
}
