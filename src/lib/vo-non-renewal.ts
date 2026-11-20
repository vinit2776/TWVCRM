/**
 * VO non-renewal checklist (pure logic).
 *
 * After a case lapses and the decision is to discontinue, a person works
 * through these steps until our address is released. The existing
 * discontinuation documents (notice approved, authority letters) are read as
 * they are; this adds the steps around them. Nothing here sends anything: the
 * second confirmation request is only drafted, for a person to send.
 */

export const CONFIRMATION_DEADLINE_DAYS = 15;

export const NON_RENEWAL_STEP_KEYS = [
  "services_off",
  "notice",
  "delivered",
  "confirmation",
  "gst_portal_check",
  "release",
] as const;
export type NonRenewalStepKey = (typeof NON_RENEWAL_STEP_KEYS)[number];

/** Keys a person can mark. The others are derived from documents or other marks. */
export const MARKABLE_KEYS = [
  "services_off",
  "delivered",
  "confirmation_requested",
  "confirmation_second_request",
  "confirmation_received",
  "gst_portal_check",
] as const;
export type MarkableKey = (typeof MARKABLE_KEYS)[number];

export const NON_RENEWAL_STEP_LABELS: Record<NonRenewalStepKey, string> = {
  services_off: "Services switched off",
  notice: "Discontinuation notice drafted and approved",
  delivered: "Notice delivered",
  confirmation: "Customer confirmation",
  gst_portal_check: "Check the GST portal",
  release: "Address release",
};

export type PlaceKind = "principal" | "additional" | "none";

/**
 * How our address was used on the customer's GST registration. Purposes that
 * never put the address on a GST registration have no portal check.
 * The legacy gst_registration purpose is treated as principal, the stricter case.
 */
export function placeKindForPurpose(purpose: string | null | undefined): PlaceKind {
  switch (purpose) {
    case "gst_new":
    case "gst_registration":
      return "principal";
    case "gst_existing":
    case "branch_office":
      return "additional";
    default:
      return "none";
  }
}

export function removalRoute(kind: PlaceKind): string {
  if (kind === "principal") {
    return "Our address is the principal place of business. The customer must name an alternative principal place, or cancel the GST registration.";
  }
  if (kind === "additional") {
    return "Our address is an additional place of business. The customer amends the registration to remove it.";
  }
  return "Our address is not on a GST registration, so there is no portal check.";
}

export interface StepMark {
  done_at: string;
  /** "done" for a completed step; "issue" when a portal check still shows our address. */
  status: "done" | "issue";
  note?: string | null;
}
export type StepMarks = Partial<Record<MarkableKey, StepMark>>;

export interface DocSummary {
  document_type: string;
  status: "draft" | "approved" | "dispatched";
}

export type StepState = "done" | "open" | "wait" | "overdue" | "skipped";

export interface ChecklistStep {
  key: NonRenewalStepKey;
  label: string;
  state: StepState;
  detail: string;
}

export type ReleaseBadge = "not_released" | "awaiting_confirmation" | "confirmed" | "released";
export const RELEASE_BADGE_LABELS: Record<ReleaseBadge, string> = {
  not_released: "Not released",
  awaiting_confirmation: "Awaiting confirmation",
  confirmed: "Confirmed",
  released: "Released",
};

const CLIENT_DOCUMENTS = ["discontinuation_notice", "dos_donts"];
const DAY_MS = 86_400_000;

export function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.floor((new Date(toIso).getTime() - new Date(fromIso).getTime()) / DAY_MS);
}

export function confirmationDeadline(requestedAt: string): string {
  return addDays(requestedAt, CONFIRMATION_DEADLINE_DAYS);
}

/** The client documents are all out of draft. An empty list is not approved. */
export function noticeApproved(docs: DocSummary[]): boolean {
  const client = docs.filter((d) => CLIENT_DOCUMENTS.includes(d.document_type));
  return client.length > 0 && client.every((d) => d.status !== "draft");
}

export function releaseBadge(input: { kind: PlaceKind; marks: StepMarks }): ReleaseBadge {
  const { kind, marks } = input;
  if (kind !== "none" && marks.gst_portal_check?.status === "done") return "released";
  if (kind === "none" && marks.confirmation_received) return "released";
  if (marks.confirmation_received) return "confirmed";
  if (marks.confirmation_requested) return "awaiting_confirmation";
  return "not_released";
}

export function computeChecklist(input: {
  purpose: string | null | undefined;
  docs: DocSummary[];
  marks: StepMarks;
  now: string;
}): { steps: ChecklistStep[]; badge: ReleaseBadge; kind: PlaceKind; deadline: string | null; overdue: boolean } {
  const { docs, marks, now } = input;
  const kind = placeKindForPurpose(input.purpose);
  const approved = noticeApproved(docs);
  const requested = marks.confirmation_requested?.done_at ?? null;
  const received = !!marks.confirmation_received;
  const deadline = requested ? confirmationDeadline(requested) : null;
  const overdue = !!deadline && !received && new Date(now).getTime() > new Date(deadline).getTime();
  const portal = marks.gst_portal_check;
  const badge = releaseBadge({ kind, marks });

  const steps: ChecklistStep[] = [];
  steps.push({
    key: "services_off",
    label: NON_RENEWAL_STEP_LABELS.services_off,
    state: marks.services_off ? "done" : "open",
    detail: "Mail handling, address listing and signage are stopped.",
  });
  steps.push({
    key: "notice",
    label: NON_RENEWAL_STEP_LABELS.notice,
    state: approved ? "done" : "open",
    detail: "Approved in the discontinuation documents below. Approving a client document emails it, as today.",
  });
  steps.push({
    key: "delivered",
    label: NON_RENEWAL_STEP_LABELS.delivered,
    state: marks.delivered ? "done" : approved ? "open" : "wait",
    detail: "Record that the notice reached the customer.",
  });

  let confirmationState: StepState = "wait";
  let confirmationDetail = "Ask the customer to remove our address and confirm in writing.";
  if (received) {
    confirmationState = "done";
    confirmationDetail = "Confirmation received.";
  } else if (requested) {
    const left = CONFIRMATION_DEADLINE_DAYS - daysBetween(requested, now);
    confirmationState = overdue ? "overdue" : "open";
    confirmationDetail = overdue
      ? `The ${CONFIRMATION_DEADLINE_DAYS} day deadline passed on ${deadline!.slice(0, 10)}.${marks.confirmation_second_request ? " A second request was drafted." : " Draft a second request."}`
      : `${left} day${left === 1 ? "" : "s"} left of ${CONFIRMATION_DEADLINE_DAYS}.`;
  } else if (marks.delivered) {
    confirmationState = "open";
  }
  steps.push({
    key: "confirmation",
    label: NON_RENEWAL_STEP_LABELS.confirmation,
    state: confirmationState,
    detail: confirmationDetail,
  });

  if (kind === "none") {
    steps.push({
      key: "gst_portal_check",
      label: NON_RENEWAL_STEP_LABELS.gst_portal_check,
      state: "skipped",
      detail: removalRoute(kind),
    });
  } else {
    const ready = received || !!docs.find((d) => d.document_type === "authority_letter" && d.status === "dispatched");
    steps.push({
      key: "gst_portal_check",
      label: NON_RENEWAL_STEP_LABELS.gst_portal_check,
      state: portal?.status === "done" ? "done" : portal?.status === "issue" ? "overdue" : ready ? "open" : "wait",
      detail:
        portal?.status === "issue"
          ? "The portal still shows our address. Chase the customer or send the authority letter."
          : `${removalRoute(kind)} Confirm on the GST taxpayer search that our address is gone.`,
    });
  }

  steps.push({
    key: "release",
    label: NON_RENEWAL_STEP_LABELS.release,
    state: badge === "released" ? "done" : "wait",
    detail: badge === "released" ? "Address released." : "Stays open until the address is confirmed removed.",
  });

  return { steps, badge, kind, deadline, overdue };
}

/** Why a mark is not allowed right now, or null when it is. */
export function markBlocker(
  key: MarkableKey,
  input: { docs: DocSummary[]; marks: StepMarks; now: string; kind: PlaceKind },
): string | null {
  const { docs, marks, now, kind } = input;
  switch (key) {
    case "services_off":
      return null;
    case "delivered":
      return noticeApproved(docs) ? null : "Approve the discontinuation notice first.";
    case "confirmation_requested":
      return marks.delivered ? null : "Record that the notice was delivered first.";
    case "confirmation_second_request": {
      const asked = marks.confirmation_requested?.done_at;
      if (!asked) return "Request the confirmation first.";
      if (marks.confirmation_received) return "Confirmation is already received.";
      return daysBetween(asked, now) >= CONFIRMATION_DEADLINE_DAYS
        ? null
        : `The second request opens after ${CONFIRMATION_DEADLINE_DAYS} days.`;
    }
    case "confirmation_received":
      return marks.confirmation_requested ? null : "Request the confirmation first.";
    case "gst_portal_check":
      if (kind === "none") return "This purpose has no GST portal check.";
      return marks.confirmation_received || docs.some((d) => d.document_type === "authority_letter" && d.status === "dispatched")
        ? null
        : "Wait for the customer's confirmation, or for the authority letter to be posted.";
  }
}

/** Text for a person to review and send. Never sent by the system. */
export function draftSecondRequest(input: {
  clientName: string;
  caseNumber: string;
  locationName: string;
  kind: PlaceKind;
  requestedAt: string;
}): { subject: string; body: string } {
  const what =
    input.kind === "principal"
      ? "name an alternative principal place of business or cancel the GST registration"
      : input.kind === "additional"
        ? "amend the GST registration to remove our address as an additional place of business"
        : "remove our address from all registrations";
  return {
    subject: `Reminder: confirm removal of The WorkVilla address (${input.caseNumber})`,
    body: [
      `Dear ${input.clientName},`,
      `We wrote on ${input.requestedAt.slice(0, 10)} asking you to confirm that our ${input.locationName} address is no longer used by you. We have not yet received that confirmation.`,
      `Please ${what}, then reply with the acknowledgement.`,
      `Until we hear from you we may write to the authority directly.`,
      `Regards,\nThe WorkVilla`,
    ].join("\n\n"),
  };
}
