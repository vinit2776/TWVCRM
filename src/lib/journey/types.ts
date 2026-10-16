export type JourneyOwner = "sales" | "accounts" | "admin" | "manager" | "ops" | "it";

/**
 * done      — the data says it happened
 * current   — the next required step nobody has done yet
 * upcoming  — required, not started, something earlier is still open
 * blocked   — cannot be done until `hint` is resolved
 * optional  — never counts toward the green flag
 */
export type JourneyStepState = "done" | "current" | "upcoming" | "blocked" | "optional";

export interface JourneyStep {
  key: string;
  phase: string;
  label: string;
  owner: JourneyOwner;
  state: JourneyStepState;
  /** Plain-language "why / what to do". Shown under the label. */
  hint?: string;
  /** Progress text such as "3 of 8" — shown beside the label. */
  detail?: string;
  /** Where the button should take the user. */
  href?: string;
  ctaLabel?: string;
  /**
   * Something the owner can do right now: the current step, or any ready step
   * in a phase whose steps are independent of each other (onboarding, billing).
   */
  actionable: boolean;
}

export interface JourneyPhase {
  key: string;
  title: string;
  steps: JourneyStep[];
  requiredDone: number;
  requiredTotal: number;
  complete: boolean;
}

export interface Journey {
  phases: JourneyPhase[];
  nextStep: JourneyStep | null;
  /** True when every required step is done — the green flag. */
  complete: boolean;
  requiredDone: number;
  requiredTotal: number;
  /** Persistent, non-blocking flags (e.g. agreement not signed). */
  warnings: string[];
}

/**
 * Plain-data snapshot the compute function works from. Built by `loadJourney`;
 * kept free of Supabase types so the logic is unit-testable.
 */
export interface JourneyInput {
  leadId: string;
  leadStatus: string;
  /** Latest enquiry for the lead, if it came through the enquiry form. */
  enquiry: { claimed: boolean; resolved: boolean } | null;
  proposal: {
    id: string;
    number: string | null;
    status: string;
    depositMonths: number;
    depositStatus: string | null;
    paymentStatus: string | null;
    waiverVerified: boolean;
    /** A non-voided first-month PI statement exists for this proposal. */
    prorataInvoiceSent: boolean;
  } | null;
  contract: {
    id: string;
    number: string | null;
    status: string;
    /** Renewals carry the deposit and skip the sales/payment phases. */
    isRenewal: boolean;
    seats: number;
    signedDocumentId: string | null;
    stamped: boolean;
    activated: boolean;
    kycTotal: number;
    kycOutstanding: number;
    spacesAllocated: number;
    members: number;
    vouchersActive: number;
    hasContractLevelVoucher: boolean;
    /** Enabled entry-point door controllers at the contract's location. */
    accessDevices: number;
    membersWithAccess: number;
    /** A non-voided rent/combined statement exists. */
    rentStatementExists: boolean;
  } | null;
}
