/**
 * The wording the renewal screens use to explain themselves: why a button is
 * disabled and how to fix it, what happens after an action, and what the
 * renewal terms mean.
 *
 * One file on purpose, so the copy can be tuned in a normal PR without
 * touching the dialogs. Pure, so each rule is unit testable. Nothing here
 * changes what a button does or sends anything.
 */

import { formatDate } from "@/lib/utils";
import { LAPSE_REASON_MIN_LENGTH, type LapseDecision } from "@/lib/vo-lapse-decision";

/** Shortest reason accepted for a custom escalation (matches the server). */
export const CUSTOM_ESCALATION_REASON_MIN = 10;
/** Shortest note accepted when confirming a partner renewal (matches the server). */
export const PARTNER_NOTE_MIN = 10;

type EscalationMode = "agreed" | "none" | "custom" | string;

function customEscalationProblems(mode: EscalationMode, customPct: string, reason: string): string[] {
  if (mode !== "custom") return [];
  const out: string[] = [];
  if (!(Number(customPct) > 0)) out.push("Enter the custom escalation percentage.");
  if (reason.trim().length < CUSTOM_ESCALATION_REASON_MIN) {
    out.push(`Give a reason for the custom percentage (at least ${CUSTOM_ESCALATION_REASON_MIN} characters).`);
  }
  return out;
}

/**
 * Why "Start renewal" is disabled, each with the way to fix it. Empty when it
 * can run, and also empty when the case can't be renewed here at all: the
 * dialog already says why in its own banner, and the form can't fix that.
 */
export function startRenewalBlockers(p: {
  /** The dialog has loaded the case and worked out an offer. */
  ready: boolean;
  /** The case can't be renewed from here at all; the dialog's banner explains. */
  cannotStart: boolean;
  mode: EscalationMode;
  customPct: string;
  reason: string;
  endConfirmed: boolean;
}): string[] {
  if (!p.ready) return [];
  if (p.cannotStart) return [];
  const out = customEscalationProblems(p.mode, p.customPct, p.reason);
  if (!p.endConfirmed) out.push("Tick the box to confirm the new term's end date.");
  return out;
}

/**
 * Why "Record confirmation" is disabled on a partner case. Empty when it can
 * run, and empty when the case has no partner or no fee (the dialog's banner
 * says so).
 */
export function partnerConfirmBlockers(p: {
  ready: boolean;
  cannotConfirm: boolean;
  mode: EscalationMode;
  customPct: string;
  reason: string;
  endConfirmed: boolean;
  noteLength: number;
}): string[] {
  if (!p.ready) return [];
  if (p.cannotConfirm) return [];
  const out = customEscalationProblems(p.mode, p.customPct, p.reason);
  if (!p.endConfirmed) out.push("Tick the box to confirm the current and new end dates.");
  if (p.noteLength < PARTNER_NOTE_MIN) {
    out.push(`Note what the partner agreed and who confirmed it (at least ${PARTNER_NOTE_MIN} characters).`);
  }
  return out;
}

/** Why "Record decision" is disabled on a lapsed case. Empty when it can run. */
export function lapseDecisionBlockers(p: {
  decision: LapseDecision | null;
  reasonLength: number;
  until: string;
  today: string;
  latestGraceDate: string;
}): string[] {
  if (!p.decision) return [];
  const out: string[] = [];
  if (p.decision === "more_time") {
    if (!p.until) out.push("Choose the date to keep the case in grace until.");
    else if (p.until <= p.today) out.push("Choose a date after today.");
    else if (p.until > p.latestGraceDate) out.push(`Choose a date no later than ${formatDate(p.latestGraceDate)}.`);
  }
  if (p.reasonLength < LAPSE_REASON_MIN_LENGTH) {
    out.push(`Write a reason of at least ${LAPSE_REASON_MIN_LENGTH} characters: who you spoke to and what they said.`);
  }
  return out;
}

/** What Start renewal tells the person once the bill is raised. */
export function startRenewalAfter(p: {
  termStart: string;
  /** Channels ticked, and whether each one was delivered. */
  email: { ticked: boolean; sent: boolean };
  whatsApp: { ticked: boolean; sent: boolean };
  hasLink: boolean;
}): { kind: "success" | "warning"; message: string } {
  const start = formatDate(p.termStart);
  const next = `When it is paid, the new term starts on ${start} by itself.`;
  const failed = (p.email.ticked && !p.email.sent) || (p.whatsApp.ticked && !p.whatsApp.sent);
  if (failed) {
    return {
      kind: "warning",
      message: `Renewal bill raised, but a message could not be delivered. Share the payment link yourself. ${next}`,
    };
  }
  const via = [p.email.sent && "email", p.whatsApp.sent && "WhatsApp"].filter(Boolean).join(" and ");
  if (via) return { kind: "success", message: `Renewal started and sent by ${via}. ${next}` };
  return {
    kind: "success",
    message: p.hasLink
      ? `Renewal bill raised. Nothing was sent: share the payment link with the payer. ${next}`
      : `Renewal bill raised without a payment link. ${next}`,
  };
}

/** What recording a lapse decision tells the person. */
export function lapseDecisionAfter(decision: LapseDecision, until?: string): string {
  switch (decision) {
    case "paid":
      return "Recorded as paid. Report the payment against the renewal bill so accounts can verify it; the new term starts then.";
    case "more_time":
      return until
        ? `More time given until ${formatDate(until)}. The case stays in grace and nothing is sent to the client.`
        : "More time given. The case stays in grace and nothing is sent to the client.";
    case "discontinue":
      return "Discontinuation started. The documents are drafts: nothing goes to the client until each one is approved.";
  }
}

/** What confirming a partner renewal tells the person. */
export function partnerConfirmAfter(p: { rolled: boolean; termStart: string }): string {
  return p.rolled
    ? "Renewed. The new term is now its own case and monthly billing continues on it."
    : `Confirmed. The case rolls into its new term on ${formatDate(p.termStart)} by itself.`;
}

export interface GlossaryEntry {
  label: string;
  definition: string;
}

/**
 * Short definitions shown on hover where a renewal term appears. The Help
 * chat's renewal sections say the same things at more length.
 */
export const RENEWAL_GLOSSARY = {
  grace: {
    label: "Grace",
    definition:
      "The few days after a term ends unpaid during which the case stays live while staff chase the payment. The length is set under Settings, Virtual office.",
  },
  lapsed: {
    label: "Lapsed",
    definition:
      "The grace period is over and the term is still unpaid. An admin or manager records whether it was paid, gets more time, or goes ahead with discontinuation.",
  },
  escalation: {
    label: "Escalation",
    definition:
      "The agreed percentage the fee goes up by at renewal. Start renewal can use it as agreed, skip it, or take a custom figure with a reason.",
  },
  continuous_term: {
    label: "Continuous term",
    definition:
      "A renewal's new term starts the day after the old one ends, however late it is paid, so there is no gap and no overlap.",
  },
  report_paid: {
    label: "Report paid",
    definition:
      "How anyone says a customer paid outside the payment link. It records the source and reference. Accounts checks it against the bank and records the payment, and only then does the new term start.",
  },
  postpaid_partner: {
    label: "Postpaid partner",
    definition:
      "A partner billed monthly in arrears for all their clients. Their cases have no renewal bill or link: staff confirm the new term with the partner instead.",
  },
} satisfies Record<string, GlossaryEntry>;

export type RenewalTerm = keyof typeof RENEWAL_GLOSSARY;
