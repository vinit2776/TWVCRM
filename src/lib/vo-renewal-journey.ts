/**
 * Where a Virtual Office case is in its renewal, what the next step is and who
 * has to do it.
 *
 * Pure, like `vo-renewal-desk.ts`, so the case page, the Renewals desk and any
 * later hint agree and the logic is unit testable. Every state is worked out
 * from data the renewal build already stores; nothing is typed in by hand, so
 * it cannot drift from the truth. A step is only ever "done" because the data
 * says so.
 *
 * Nothing here contacts a customer: a step's action is a pointer to the button
 * that already exists.
 */

import { PAYMENT_RECORDING_ROLES } from "@/lib/constants";
import { LAPSE_DECISION_ROLES } from "@/lib/vo-lapse-decision";
import { daysUntil } from "@/lib/vo-renewal-desk";

export type RenewalOwner = "sales" | "accounts" | "admin" | "payer" | "system";

export const RENEWAL_OWNER_LABELS: Record<RenewalOwner, string> = {
  sales: "Sales",
  accounts: "Accounts",
  admin: "Admin or manager",
  payer: "The payer",
  system: "Automatic",
};

/**
 * done     — the data says it happened
 * current  — the next required step nobody has done yet
 * upcoming — required, but something earlier is still open
 * blocked  — cannot be done until `hint` is resolved
 * optional — information only; never the next step
 */
export type RenewalStepState = "done" | "current" | "upcoming" | "blocked" | "optional";

/** The button that does the step; the screen maps it to a click or a link. */
export type RenewalAction =
  | "start_renewal"
  | "confirm_partner"
  | "report_paid"
  | "verify_payment"
  | "decide_lapse"
  | "review_discontinuation"
  | "open_successor";

export interface RenewalStep {
  key: string;
  label: string;
  owner: RenewalOwner;
  /** Roles that can do the step; null when nobody here does (the payer, the system). */
  roles: readonly string[] | null;
  state: RenewalStepState;
  /** Plain-language "what this is and what to do". */
  hint?: string;
  /** Short facts beside the label: "₹59,000 reported 12 Dec". */
  detail?: string;
  action?: RenewalAction;
  actionLabel?: string;
  /** For open_successor: the case to open. */
  targetCaseId?: string;
}

export type RenewalStage = "renewal" | "grace" | "lapsed" | "renewed";

export interface RenewalJourney {
  stage: RenewalStage;
  branch: "direct" | "partner";
  /** One line: the term the case is heading for and the date it must be settled by. */
  goal: string;
  daysLeft: number | null;
  steps: RenewalStep[];
  /** The first step still to do; null when the renewal is complete. */
  nextStep: RenewalStep | null;
  /** True once the renewal needs nothing further from anyone. */
  complete: boolean;
}

/** Plain data the journey is worked out from; built by the desk and case routes. */
export interface RenewalJourneyInput {
  today: string;
  caseStatus: string;
  endDate: string | null;
  /** The last day the case is still in grace, when it is. */
  graceLastDay: string | null;
  purpose: string | null;
  payer: {
    postpaid: boolean;
    /** Why the bill-to cannot be resolved, or null. */
    blocked: string | null;
    hasEmail: boolean;
    hasPhone: boolean;
  };
  openBill: {
    statementNumber: string | null;
    totalAmount: number;
    periodStart: string | null;
    periodEnd: string | null;
  } | null;
  notices: { count: number };
  /** A "Report paid" accounts has not yet checked against the bank. */
  openReport: { amount: number; paidOn: string; reportedBy: string | null } | null;
  partnerConfirmation: { termStart: string; newRate: number } | null;
  lapse: {
    latestDecision: "paid" | "more_time" | "discontinue" | null;
    draftDocuments: number;
    /** At least one discontinuation document has gone to the client. */
    documentsSent: boolean;
  };
  /** The case this renewal produced, once paid. */
  successor: { id: string; caseNumber: string | null } | null;
}

const SALES_ROLES = ["sales_rep", "manager", "admin"] as const;
const START_ROLES = ["admin", "manager", "sales_rep", "accounts"] as const;
const PARTNER_ROLES = ["admin", "manager", "sales_rep"] as const;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(date.slice(0, 10) + "T00:00:00Z") + days * 86_400_000).toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "19 Dec 2026", without a locale so server and browser read the same. */
function day(date: string): string {
  const [y, m, d] = date.slice(0, 10).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

function money(n: number): string {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

/** Marks the first required step that is not done as current, the rest after it as upcoming. */
function sequence(steps: RenewalStep[]): RenewalStep[] {
  let found = false;
  return steps.map((s) => {
    if (s.state === "optional" || s.state === "done") return s;
    if (s.state === "blocked") {
      found = true;
      return s;
    }
    if (!found) {
      found = true;
      return { ...s, state: "current" as const };
    }
    return { ...s, state: "upcoming" as const };
  });
}

export function computeRenewalJourney(input: RenewalJourneyInput): RenewalJourney {
  const { today, endDate } = input;
  const daysLeft = endDate ? daysUntil(endDate, today) : null;
  const renewed = input.caseStatus === "renewed" || !!input.successor;
  const ended = daysLeft !== null && daysLeft < 0;
  const lapsed = input.caseStatus === "lapsed";
  const stage: RenewalStage = renewed ? "renewed" : lapsed ? "lapsed" : ended ? "grace" : "renewal";
  const branch = input.payer.postpaid ? "partner" : "direct";

  // Step 1: the facts every later step relies on.
  const problems: string[] = [];
  if (!endDate) problems.push("add the end date");
  if (input.payer.blocked) problems.push(input.payer.blocked.replace(/\.$/, "").toLowerCase());
  if (!input.purpose) problems.push("set the Virtual Office purpose");
  if (!input.payer.postpaid && !input.payer.hasEmail && !input.payer.hasPhone) {
    problems.push("add an email or phone for the payer");
  }
  const check: RenewalStep = {
    key: "check",
    label: "Check the case",
    owner: "sales",
    roles: SALES_ROLES,
    state: renewed || problems.length === 0 ? "done" : "blocked",
    hint:
      problems.length === 0
        ? undefined
        : `Before renewing, ${problems.join("; ")}.`,
  };

  const steps: RenewalStep[] = [check];

  if (branch === "partner") {
    const conf = input.partnerConfirmation;
    steps.push({
      key: "partner",
      label: "Confirm with the partner",
      owner: "sales",
      roles: PARTNER_ROLES,
      state: renewed || conf ? "done" : "upcoming",
      hint: conf
        ? undefined
        : "A postpaid partner has no renewal bill. Confirm the new term and fee with the partner, and billing moves to the new term.",
      detail: conf ? `New term from ${day(conf.termStart)} at ${money(conf.newRate)}` : undefined,
      action: conf ? undefined : "confirm_partner",
      actionLabel: "Confirm partner renewal",
    });
    steps.push({
      key: "term",
      label: "New term starts",
      owner: "system",
      roles: null,
      state: renewed ? "done" : "upcoming",
      hint: renewed ? undefined : "Rolls on by itself once the partner is confirmed.",
    });
  } else {
    const bill = input.openBill;
    const reported = input.openReport;

    steps.push({
      key: "start",
      label: "Start renewal",
      owner: "sales",
      roles: START_ROLES,
      state: renewed || bill ? "done" : "upcoming",
      hint: bill
        ? undefined
        : "Choose the length and escalation. This raises one renewal bill and one payment link; nothing is sent unless you tick a channel.",
      detail: bill?.statementNumber ?? undefined,
      action: bill ? undefined : "start_renewal",
      actionLabel: "Start renewal",
    });

    // Sharing the link is not tracked unless a notice goes out through the app
    // (staff may hand the link over themselves), so with a bill and no logged
    // notice it is a reminder, never a step that holds up the next one.
    const told = input.notices.count > 0;
    steps.push({
      key: "tell",
      label: "Tell the payer",
      owner: "sales",
      roles: START_ROLES,
      state: renewed || told ? "done" : bill ? "optional" : "upcoming",
      hint:
        renewed || told
          ? undefined
          : "Send the payment link by email or WhatsApp, or share it yourself. The notices log fills in only when a notice goes out through the CRM.",
      detail: told ? `${input.notices.count} notice${input.notices.count === 1 ? "" : "s"} sent` : undefined,
    });

    steps.push({
      key: "pay",
      label: "Payment",
      owner: "payer",
      roles: null,
      state: renewed ? "done" : "upcoming",
      hint:
        renewed
          ? undefined
          : "A paid link confirms itself. If the payer paid another way, anyone can use Report paid with the source and reference.",
      detail: bill ? `${bill.statementNumber ?? "Renewal bill"} · ${money(bill.totalAmount)}` : undefined,
      action: bill && !reported ? "report_paid" : undefined,
      actionLabel: "Report paid",
    });

    // Only a reported payment makes verifying a step; a link payment never needs it.
    steps.push({
      key: "verify",
      label: "Verify and record",
      owner: "accounts",
      roles: PAYMENT_RECORDING_ROLES,
      state: renewed ? "done" : reported ? "upcoming" : "optional",
      hint: reported
        ? "Check it against the bank statement and record it. The new term starts once recorded."
        : "Only needed if the payer paid outside the link.",
      detail: reported
        ? `${money(reported.amount)} reported ${day(reported.paidOn)}${reported.reportedBy ? ` by ${reported.reportedBy}` : ""}`
        : undefined,
      action: reported ? "verify_payment" : undefined,
      actionLabel: "Verify payment",
    });

    steps.push({
      key: "term",
      label: "New term starts",
      owner: "system",
      roles: null,
      state: renewed ? "done" : "upcoming",
      hint: renewed
        ? undefined
        : "When the bill is paid, the new term starts the day after this one ends, as its own case.",
      detail: input.successor?.caseNumber ?? undefined,
      action: input.successor ? "open_successor" : undefined,
      actionLabel: "Open new term",
      targetCaseId: input.successor?.id,
    });

    // A reported payment means "Payment" is no longer what the case waits on.
    if (!renewed && reported) {
      const i = steps.findIndex((s) => s.key === "pay");
      steps[i] = { ...steps[i], state: "done", detail: `Reported ${money(reported.amount)}`, action: undefined };
    }
  }

  // After the end date unpaid: the grace window and then the lapsed decision.
  if (!renewed && stage === "grace" && input.graceLastDay) {
    const left = Math.max(0, daysUntil(input.graceLastDay, today));
    steps.push({
      key: "grace",
      label: "In grace",
      owner: "sales",
      roles: SALES_ROLES,
      state: "optional",
      hint: "The term has ended unpaid. Call the client; a payment moves the case straight back to the steps above.",
      detail: left === 0 ? "Last grace day today" : `${left} grace day${left === 1 ? "" : "s"} left`,
    });
  }

  if (!renewed && stage === "lapsed") {
    // The decision comes before any renewal step: a lapsed case is not
    // renewed until an admin or manager says it has been paid or discontinued.
    const decided = input.lapse.latestDecision;
    const lapseSteps: RenewalStep[] = [
      {
        key: "lapse",
        label: "Decide: paid, more time or discontinue",
        owner: "admin",
        roles: LAPSE_DECISION_ROLES,
        state: decided ? "done" : "upcoming",
        hint: decided ? undefined : "The grace period is over. Record a decision with a reason; it goes to the audit trail.",
        action: decided ? undefined : "decide_lapse",
        actionLabel: "Decide",
      },
    ];
    if (decided === "discontinue") {
      const drafts = input.lapse.draftDocuments;
      lapseSteps.push({
        key: "discontinue",
        label: "Review discontinuation documents",
        owner: "admin",
        roles: LAPSE_DECISION_ROLES,
        state: drafts === 0 && input.lapse.documentsSent ? "done" : "upcoming",
        hint: "Nothing goes to the client until each document is approved.",
        detail: drafts > 0 ? `${drafts} draft${drafts === 1 ? "" : "s"} to review` : undefined,
        action: drafts > 0 ? "review_discontinuation" : undefined,
        actionLabel: "Review drafts",
      });
    }
    // Discontinuing sets the renewal steps aside rather than hiding them.
    const rest = steps.slice(1).map((st) =>
      decided === "discontinue" && st.state !== "done" ? { ...st, state: "optional" as const } : st,
    );
    steps.splice(1, steps.length - 1, ...lapseSteps, ...rest);
  }

  const sequenced = sequence(steps);
  const nextStep = sequenced.find((s) => s.state === "current" || s.state === "blocked") ?? null;

  return {
    stage,
    branch,
    goal: goalLine(input, stage),
    daysLeft,
    steps: sequenced,
    nextStep,
    complete: renewed,
  };
}

function goalLine(input: RenewalJourneyInput, stage: RenewalStage): string {
  const { endDate, openBill } = input;
  if (stage === "renewed") {
    return input.successor?.caseNumber ? `Renewed as ${input.successor.caseNumber}` : "Renewed";
  }
  if (!endDate) return "Add an end date to plan the renewal";
  const start = openBill?.periodStart ?? addDays(endDate, 1);
  const term = openBill?.periodEnd ? `New term ${day(start)} to ${day(openBill.periodEnd)}` : `New term starts ${day(start)}`;
  const by = input.payer.postpaid ? "confirmed" : "paid and active";
  return `${term}, ${by} before ${day(endDate)}`;
}

/** What one person should see for a journey, given their role. */
export interface RenewalNextStepView {
  step: RenewalStep;
  /** The viewer's role can do this step now. */
  mine: boolean;
  /** For someone else's step: who it waits on. */
  waitingOn: string | null;
}

export function nextStepFor(journey: RenewalJourney, role: string | null): RenewalNextStepView | null {
  const step = journey.nextStep;
  if (!step) return null;
  const mine = !!role && !!step.roles && step.roles.includes(role);
  return { step, mine, waitingOn: mine ? null : RENEWAL_OWNER_LABELS[step.owner] };
}

/** Whether the "Needs me" filter should include this journey for the role. */
export function needsRole(journey: RenewalJourney, role: string | null): boolean {
  return nextStepFor(journey, role)?.mine ?? false;
}
