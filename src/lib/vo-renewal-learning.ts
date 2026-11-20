/**
 * How the renewal guidance adapts to each person.
 *
 * An explanation is long until someone has done that step a few times, then
 * one line; a failed attempt brings the long version back for that step. The
 * counts are per person and kept on the server (user_guidance_progress), so
 * staff sharing a front-desk computer don't inherit each other's progress.
 *
 * Pure, so the rules are unit testable. Nothing here changes what a step does
 * or reaches a customer.
 */

/** Completions of a step after which its explanation shrinks to one line. */
export const FADE_AFTER_COMPLETIONS = 3;

/** One row of user_guidance_progress, as the API returns it. */
export interface GuidanceProgress {
  times_completed: number;
  last_completed_at: string | null;
  last_blocked_at: string | null;
}

export type GuidanceDetail = "long" | "short";

/**
 * Which version of a step's explanation to show. Long until the step has been
 * completed FADE_AFTER_COMPLETIONS times, and long again whenever the person
 * has been blocked on it since they last completed it.
 */
export function guidanceDetail(progress: GuidanceProgress | null | undefined): GuidanceDetail {
  if (!progress || progress.times_completed < FADE_AFTER_COMPLETIONS) return "long";
  if (progress.last_blocked_at && (!progress.last_completed_at || progress.last_blocked_at > progress.last_completed_at)) {
    return "long";
  }
  return "short";
}

/** Progress keys: the journey step a person does, and one-off guides. */
export const RENEWAL_STEP_PREFIX = "renewal.";
export const WALKTHROUGH_KEY = "walkthrough.renewals";

/** Journey steps a person does through a dialog the app can see finish. */
export const FADING_STEPS = ["start", "partner", "lapse"] as const;
export type FadingStep = (typeof FADING_STEPS)[number];

export function progressKeyFor(step: string): string {
  return `${RENEWAL_STEP_PREFIX}${step}`;
}

/** Whether `key` is one the progress API accepts. */
export function isGuidanceKey(key: string): boolean {
  return (
    key === WALKTHROUGH_KEY ||
    (FADING_STEPS as readonly string[]).some((s) => key === progressKeyFor(s))
  );
}

/** The one-line version of a step's explanation; undefined for steps that don't fade. */
export function shortHintFor(step: string): string | undefined {
  switch (step) {
    case "start":
      return "Choose the length and escalation, confirm the end date.";
    case "partner":
      return "Confirm the new term and fee with the partner.";
    case "lapse":
      return "Record paid, more time or discontinue, with a reason.";
    default:
      return undefined;
  }
}

export interface WalkthroughStep {
  title: string;
  body: string;
  /** What this means for the person's own role, when it differs. */
  forYou?: string;
}

const SALES_ROLES = ["sales_rep", "manager"];

/** The five-step tour of the renewal journey, with a line for the viewer's role. */
export function renewalWalkthrough(role: string | null): WalkthroughStep[] {
  const sales = !!role && SALES_ROLES.includes(role);
  const accounts = role === "accounts";
  const admin = role === "admin";
  return [
    {
      title: "Every case shows where it stands",
      body: "A case appears here 60 days before its term ends. Its row names the next step and who has to do it, so nobody has to guess whether to chase.",
    },
    {
      title: "Start renewal raises the bill",
      body: "Choose the length and escalation, confirm the end date, and one renewal bill with one payment link is raised. Email and WhatsApp stay unticked unless you tick them.",
      forYou: sales || admin ? "This is your step: start from the case's Renewal tab." : accounts ? "Sales usually starts it; you can too." : undefined,
    },
    {
      title: "Payment settles itself, or is reported",
      body: "A paid link needs nothing from anyone. If the customer paid another way, anyone can use Report paid with the source and reference.",
    },
    {
      title: "Accounts verifies, then the new term starts",
      body: "A reported payment is checked against the bank and recorded. Then the new term starts the day after the old one ends, as its own case.",
      forYou: accounts || admin ? "Verifying and recording is yours." : "You'll see \"Waiting on accounts\" on these.",
    },
    {
      title: "If it isn't paid",
      body: "The case stays live for a few grace days, then lapses. An admin or manager records whether it was paid, gives more time, or goes ahead with discontinuation. Nothing is sent without a person's click.",
    },
  ];
}
