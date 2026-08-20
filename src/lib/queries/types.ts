/**
 * Shared types for the Queries module — clarification threads that hang off
 * any transaction in the CRM.
 *
 * Kept free of server-only imports (mailer, supabase server client) because
 * the thread panel and query button are client components and import from
 * here. See registry.ts for the per-entity definitions and audience.ts for
 * the routing rules.
 */

import type { UserRole } from "@/types";

/**
 * Every kind of transaction a query can hang off. Adding one is a registry
 * entry in registry.ts, not a migration — queries.entity_type is a plain TEXT
 * column deliberately, so new surfaces don't need schema changes.
 */
export const QUERY_ENTITY_TYPES = [
  "billing_statement",
  "booking_gst_task",
  "proposal_deposit",
  "deposit_topup",
  "vendor_bill",
  "contract",
  "purchase_order",
  "purchase_request",
] as const;

export type QueryEntityType = (typeof QUERY_ENTITY_TYPES)[number];

export function isQueryEntityType(value: string | null | undefined): value is QueryEntityType {
  return !!value && (QUERY_ENTITY_TYPES as readonly string[]).includes(value);
}

/** Groups entity types for the module filter chips on /queries. */
export type QueryModule = "billing" | "tally_inbox" | "payables" | "contracts" | "procurement";

export const QUERY_MODULE_LABELS: Record<QueryModule, string> = {
  billing: "Billing",
  tally_inbox: "Tally Inbox",
  payables: "Payables",
  contracts: "Contracts",
  procurement: "Procurement",
};

export type QueryStatus = "open" | "resolved";

/** 'question' just needs an answer; 'action_needed' means the responder has
 *  to change something (fix a rate, raise a revised PO, upload a doc) before
 *  it can be resolved; 'payment_reported' carries an out-of-system payment
 *  someone was told about, and is the only kind with structured fields
 *  alongside the prose (see src/lib/queries/payment-reports.ts). */
export type QueryKind = "question" | "action_needed" | "payment_reported";

export const QUERY_KIND_LABELS: Record<QueryKind, string> = {
  question: "Question",
  action_needed: "Action needed",
  payment_reported: "Payment reported",
};

/**
 * The kinds the free-text composer offers.
 *
 * 'payment_reported' is deliberately absent: it needs amount, date, mode and
 * remitter, so it has its own dialog (ReportPaymentDialog) and its own
 * endpoint. Offering it as a chip here would produce reports with no fields —
 * exactly the unreconcilable prose this feature replaces.
 */
export const COMPOSER_QUERY_KINDS: readonly QueryKind[] = ["question", "action_needed"];

/**
 * Who a query is addressed to.
 *
 * This is *routing*, never visibility — a thread addressed to one person is
 * still readable by everyone authorized on that entity. Deliberate: an
 * accounting trail shouldn't have hidden side conversations, and the loop
 * shouldn't stall because one person is on leave.
 */
export type QueryAudience = "all" | "roles" | "users";

export type QueryMessageEventType =
  | "message"
  | "resolved"
  | "reopened"
  | "retargeted"
  | "nudged"
  | "payment_verified"
  | "payment_rejected";

export interface QueryAuthor {
  id: string;
  full_name: string;
  role: string;
}

export interface QueryAttachment {
  id: string;
  file_name: string;
  file_mime_type: string;
  size_bytes: number | null;
}

export interface QueryMessage {
  id: string;
  event_type: QueryMessageEventType;
  body: string | null;
  created_by: QueryAuthor;
  created_at: string;
  attachments?: QueryAttachment[];
}

/** Max files per message. Enough for "here are the three screenshots",
 *  low enough that nobody dumps a folder into a conversation. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/**
 * Display-ready summary of whatever transaction a query hangs off, produced
 * by the registry's toSummary(). Deliberately display fields only — never a
 * payload the viewer couldn't otherwise see. `href` is populated only when
 * the entity has a page worth linking to; the UI additionally hides it from
 * viewers whose role can't open that route.
 */
export interface QueryEntitySummary {
  id: string;
  /** Primary line: who this is about. e.g. "Bluescale Analytics" */
  title: string;
  /**
   * Extra context beyond the label and reference. Cards render these as
   * `label · reference · subtitle`, so the subtitle must NOT repeat either —
   * "Deposit top-up · TWV-C-0112 · TWV-C-0112 · Deposit top-up" is what you
   * get when it does.
   */
  subtitle: string;
  /** Rendered with formatCurrency when present. */
  amount: number | null;
  /** Identifier shown alongside the subtitle, e.g. a statement number. */
  reference: string | null;
  href: string | null;
}

/** The audience of a query, as stored. */
export interface QueryTargeting {
  audience: QueryAudience;
  audience_roles: UserRole[];
  audience_user_ids: string[];
}

export interface QueryListItem extends QueryTargeting {
  id: string;
  entity_type: QueryEntityType;
  entity_id: string;
  status: QueryStatus;
  kind: QueryKind;
  created_by: QueryAuthor;
  created_at: string;
  updated_at: string;
  resolved_by: QueryAuthor | null;
  resolved_at: string | null;
  needed_by: string | null;
  /** null when the underlying transaction can no longer be resolved — the
   *  card renders "transaction no longer available" rather than failing. */
  entity: QueryEntitySummary | null;
  last_message: { body: string | null; event_type: QueryMessageEventType; created_at: string } | null;
  /** The amount claimed, on 'payment_reported' threads only. Null elsewhere. */
  reported_amount?: number | null;
  /** True when this viewer is the one expected to act next. Computed by
   *  isAwaitingUser() in audience.ts. */
  awaiting_viewer: boolean;
}

export interface QueryThread extends Omit<QueryListItem, "last_message"> {
  messages: QueryMessage[];
  /** Names resolved for audience_user_ids, so the thread header can show
   *  "→ Priya S" without the client doing a second lookup. */
  audience_users: QueryAuthor[];
  /** Present only when kind === 'payment_reported'. */
  payment_report?: QueryPaymentReport | null;
}

/** A canned opening question, offered as a chip in the composer. */
export interface QueryTemplate {
  key: string;
  label: string;
  body: string;
}

export interface QueryStats {
  awaiting_you: number;
  overdue: number;
  open: number;
  resolved_this_week: number;
}

/**
 * The structured half of a 'payment_reported' thread. Present on a thread
 * only for that kind; every other query has none.
 *
 * `billing_payment_id` is the join this feature exists to create — until it
 * is set, this record has had no effect on any balance anywhere.
 */
export interface QueryPaymentReport {
  id: string;
  status: "reported" | "verified" | "rejected";
  /** 'invoice' settles a statement; 'deposit' settles a proposal deposit. */
  target_kind: "invoice" | "deposit";
  amount: number;
  paid_on: string;
  payment_mode: string;
  payment_reference: string | null;
  payer_name: string | null;
  payer_differs: boolean;
  billing_payment_id: string | null;
  /** The invoice the reporter was told this covers. Pre-selects allocation. */
  claimed_statement_id: string | null;
  claimed_statement: { id: string; statement_number: string | null } | null;
  resolution_note: string | null;
  reviewed_at: string | null;
  reviewed_by: QueryAuthor | null;
  created_by: QueryAuthor;
  created_at: string;
}
