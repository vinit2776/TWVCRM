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
  // Later PRs add: booking_gst_task, proposal_deposit, deposit_topup,
  // vendor_bill, contract, purchase_order, purchase_request.
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
 *  it can be resolved. */
export type QueryKind = "question" | "action_needed";

export const QUERY_KIND_LABELS: Record<QueryKind, string> = {
  question: "Question",
  action_needed: "Action needed",
};

/**
 * Who a query is addressed to.
 *
 * This is *routing*, never visibility — a thread addressed to one person is
 * still readable by everyone authorized on that entity. Deliberate: an
 * accounting trail shouldn't have hidden side conversations, and the loop
 * shouldn't stall because one person is on leave.
 */
export type QueryAudience = "all" | "roles" | "users";

export type QueryMessageEventType = "message" | "resolved" | "reopened" | "retargeted";

export interface QueryAuthor {
  id: string;
  full_name: string;
  role: string;
}

export interface QueryMessage {
  id: string;
  event_type: QueryMessageEventType;
  body: string | null;
  created_by: QueryAuthor;
  created_at: string;
}

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
  /** Secondary line: which record. e.g. "TWV-C-0112 · Open Desk" */
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
  /** True when this viewer is the one expected to act next. Computed by
   *  isAwaitingUser() in audience.ts. */
  awaiting_viewer: boolean;
}

export interface QueryThread extends Omit<QueryListItem, "last_message"> {
  messages: QueryMessage[];
  /** Names resolved for audience_user_ids, so the thread header can show
   *  "→ Priya S" without the client doing a second lookup. */
  audience_users: QueryAuthor[];
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
