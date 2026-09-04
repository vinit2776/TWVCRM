/**
 * Out-of-system payments, reported by whoever the customer told.
 *
 * A customer pays by NEFT against a bank advice instead of the Razorpay link,
 * WhatsApps the screenshot to their floor manager or sales rep, and accounts
 * never hear about it in a shape they can reconcile. This module is the
 * structured half of closing that loop; the conversational half is an
 * ordinary `queries` thread (kind = 'payment_reported'), which is what buys
 * the attachments, the audience routing and the nudge cron for free.
 *
 * Pure — no Supabase, no mailer — so the rules below are unit testable and
 * the client can validate the form without a round trip.
 *
 * THE ONE INVARIANT: a report is a *claim*, never a payment. Nothing in this
 * module writes to billing_payments, and no field here feeds amount_paid or
 * balance_due. Receivables move when accounts see the credit in the bank and
 * verify, which records a real payment through the existing endpoint and
 * stores its id on the report. See 00510_query_payment_reports.sql.
 */

import type { UserRole } from "@/types";
import { STATEMENT_PAYMENT_MODES } from "@/lib/constants";

/** Reports hang off one of these. */
export const PAYMENT_REPORT_ENTITY_TYPES = [
  "contract",
  "billing_statement",
  "proposal_deposit",
  "deposit_topup",
] as const;
export type PaymentReportEntityType = (typeof PAYMENT_REPORT_ENTITY_TYPES)[number];

/**
 * What a report settles against, and therefore what counts as proof it was
 * verified.
 *
 *   invoice — a billing statement. Proof is the billing_payments row created
 *             when accounts record it, stored in billing_payment_id.
 *   deposit — a proposal security deposit, or a deposit top-up. Neither has a
 *             payment row of its own — proof is the source row's own status
 *             flag (deposit_payment_status / deposit_topups.status) flipping
 *             to 'paid', re-checked server-side before a report may be
 *             marked verified.
 */
export type PaymentReportTargetKind = "invoice" | "deposit";

export function targetKindForEntity(entityType: PaymentReportEntityType): PaymentReportTargetKind {
  return entityType === "proposal_deposit" || entityType === "deposit_topup" ? "deposit" : "invoice";
}

/**
 * Deposits are recorded by admin/manager/accounts
 * (/api/proposals/[id]/deposit-payment), a wider set than the invoice path.
 * Verification stays on the narrower PAYMENT_REPORT_REVIEW_ROLES either way:
 * confirming an unverified claim means reading the bank statement, which is
 * a different act from recording a payment you were already told about.
 */
export const DEPOSIT_RECORD_ROLES: readonly UserRole[] = ["admin", "manager", "accounts"];

export type PaymentReportStatus = "reported" | "verified" | "rejected";

export const PAYMENT_REPORT_TARGET_LABELS: Record<PaymentReportTargetKind, string> = {
  invoice: "Invoice payment",
  deposit: "Security deposit",
};

export const PAYMENT_REPORT_STATUS_LABELS: Record<PaymentReportStatus, string> = {
  reported: "Reported · unverified",
  verified: "Verified",
  rejected: "No such payment",
};

export const PAYMENT_REPORT_STATUS_COLORS: Record<PaymentReportStatus, string> = {
  reported: "bg-amber-50 border-amber-200 text-amber-800",
  verified: "bg-green-50 border-green-200 text-green-800",
  rejected: "bg-red-50 border-red-200 text-red-800",
};

/**
 * Who can act on a report once it exists.
 *
 * Deliberately narrower than who can raise one: reporting is open to every
 * authenticated user (the customer tells whoever they deal with, and a role
 * gate there would just rebuild the gap), but only the people who can see the
 * bank account can say a credit arrived. This mirrors the record-payment gate
 * in /api/billing-statements/[id]/payment, minus `manager` — a manager can
 * record a payment they were told about, but shouldn't be the one confirming
 * an unverified claim against a bank statement they don't reconcile.
 */
export const PAYMENT_REPORT_REVIEW_ROLES: readonly UserRole[] = ["admin", "accounts"];

export function canReviewPaymentReport(role: string | null | undefined): boolean {
  return !!role && (PAYMENT_REPORT_REVIEW_ROLES as readonly string[]).includes(role);
}

/**
 * The default audience for a new report.
 *
 * Matches PAYMENT_REPORT_REVIEW_ROLES, not `all`: "all" on a contract means
 * the sales rep and floor manager get paged about a bank reconciliation they
 * can't perform, but leaving admin out (as accounts-only once did) meant an
 * admin never saw an unverified report in their "Awaiting you" queue even
 * though they're allowed to verify it. Routing only — the thread stays
 * readable by everyone authorized on the entity, same as every other query.
 */
export const PAYMENT_REPORT_AUDIENCE_ROLES: readonly UserRole[] = ["admin", "accounts"];

/**
 * How long accounts get before the thread starts chasing itself.
 *
 * Two working days: long enough that a payment made on Friday evening has
 * cleared and appeared on a statement, short enough that the claim doesn't go
 * cold. Fed to queries.needed_by, which the existing nudge cron reads.
 */
export const PAYMENT_REPORT_DUE_DAYS = 2;

export function defaultNeededBy(today: Date): string {
  const due = new Date(today);
  due.setDate(due.getDate() + PAYMENT_REPORT_DUE_DAYS);
  return due.toISOString().slice(0, 10);
}

/**
 * Loosely typed on purpose — this is whatever arrived over the wire, and
 * every field is narrowed by validatePaymentReport before it goes anywhere
 * near the database.
 */
export interface PaymentReportInput {
  amount?: unknown;
  paid_on?: unknown;
  payment_mode?: unknown;
  payment_reference?: unknown;
  payer_name?: unknown;
  payer_differs?: unknown;
}

export interface PaymentReportFields {
  amount: number;
  paid_on: string;
  payment_mode: string;
  payment_reference: string | null;
  payer_name: string | null;
  payer_differs: boolean;
}

const VALID_MODES = new Set<string>(STATEMENT_PAYMENT_MODES.map((m) => m.value));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reports of payments this far in the future are a typo, not a payment. */
export const MAX_FUTURE_DAYS = 1;
/** Anything older than this is a reconciliation job, not a fresh report. */
export const MAX_AGE_DAYS = 180;

function trimmedOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Validate what ops typed.
 *
 * `payment_reference` stays optional on purpose. Someone forwarding a
 * screenshot frequently doesn't have the UTR to hand, and rejecting the
 * report over it sends them back to WhatsApp — which is the behaviour this
 * feature exists to replace. An unreferenced report is still far more useful
 * to accounts than no report: amount, date and remitter usually pin the
 * credit down on their own.
 */
export function validatePaymentReport(
  input: PaymentReportInput,
  today: Date,
): { ok: true; value: PaymentReportFields } | { ok: false; error: string } {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Enter the amount the customer says they paid" };
  }

  const paidOn = typeof input.paid_on === "string" ? input.paid_on.trim() : "";
  if (!ISO_DATE.test(paidOn) || Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`))) {
    return { ok: false, error: "Enter a valid payment date" };
  }

  const todayMs = Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`);
  const paidMs = Date.parse(`${paidOn}T00:00:00Z`);
  const dayDiff = Math.round((paidMs - todayMs) / 86_400_000);
  if (dayDiff > MAX_FUTURE_DAYS) {
    return { ok: false, error: "That payment date is in the future" };
  }
  if (dayDiff < -MAX_AGE_DAYS) {
    return { ok: false, error: `Payments older than ${MAX_AGE_DAYS} days can't be reported here` };
  }

  const mode = typeof input.payment_mode === "string" ? input.payment_mode.trim() : "";
  if (!VALID_MODES.has(mode)) {
    return { ok: false, error: "Select how the customer paid" };
  }

  const payerDiffers = input.payer_differs === true || input.payer_differs === "true";
  const payerName = trimmedOrNull(input.payer_name);
  // The whole point of the flag is to name the account, so a tick with no
  // name is worse than no tick — it tells accounts to expect a mismatch
  // without telling them what to look for.
  if (payerDiffers && !payerName) {
    return { ok: false, error: "Enter the name on the account the payment came from" };
  }

  return {
    ok: true,
    value: {
      amount: Math.round(amount * 100) / 100,
      paid_on: paidOn,
      payment_mode: mode,
      payment_reference: trimmedOrNull(input.payment_reference),
      payer_name: payerName,
      payer_differs: payerDiffers,
    },
  };
}

/**
 * The three ways accounts can answer a report.
 *
 * `not_found` is the one that does the real work: it is NOT a rejection, it
 * leaves the report at 'reported' and the thread open so the nudge cron keeps
 * working it. Without it the only honest answer to "I can't see it yet" is
 * silence, and silence is what the whole feature is replacing.
 */
export type PaymentReportOutcome = "verified" | "not_found" | "rejected";

export const PAYMENT_REPORT_OUTCOMES: readonly PaymentReportOutcome[] = [
  "verified",
  "not_found",
  "rejected",
];

export function isPaymentReportOutcome(value: unknown): value is PaymentReportOutcome {
  return typeof value === "string" && (PAYMENT_REPORT_OUTCOMES as readonly string[]).includes(value);
}

/** What each outcome writes to query_payment_reports.status. */
export function statusForOutcome(outcome: PaymentReportOutcome): PaymentReportStatus {
  return outcome === "verified" ? "verified" : outcome === "rejected" ? "rejected" : "reported";
}

/** One-line summary for notification bodies and the audit trail. */
export function describeReport(fields: PaymentReportFields, modeLabel: string): string {
  const parts = [`₹${fields.amount.toLocaleString("en-IN")}`, modeLabel, fields.paid_on];
  if (fields.payment_reference) parts.push(`ref ${fields.payment_reference}`);
  if (fields.payer_differs && fields.payer_name) parts.push(`from ${fields.payer_name}`);
  return parts.join(" · ");
}
