/**
 * Billing Queries — accounts-to-management question threads on a billing
 * statement. Accounts raises a question from the Tally Inbox; admin/manager/
 * sales_rep see and answer it from the standalone /billing-queries page,
 * independent of Tally Inbox access (sales_rep has none there — see
 * INBOX_ROLES in tally-handoff.ts).
 *
 * Mirrors the shape of facility_issue_events (typed timeline: message /
 * resolved / reopened) rather than a plain comment list, so a resolution
 * note shows up inline with the replies instead of as a disconnected field.
 */

/** Roles permitted to see and act on billing queries. Deliberately a
 *  separate list from INBOX_ROLES — sales_rep belongs here but has no
 *  Tally Inbox access at all. */
export const BILLING_QUERY_ROLES = ["accounts", "admin", "office_admin", "manager", "sales_rep"] as const;
export type BillingQueryRole = (typeof BILLING_QUERY_ROLES)[number];

export function isBillingQueryRole(role: string | null | undefined): role is BillingQueryRole {
  return !!role && (BILLING_QUERY_ROLES as readonly string[]).includes(role);
}

/** Roles that receive outbound alerts (email, WhatsApp escalation) — a
 *  narrower set than BILLING_QUERY_ROLES. Admin/office_admin can see and act
 *  on every query in-app, but don't need to be paged for each one; they're
 *  monitoring, not on the hook to respond. */
export const BILLING_QUERY_ALERT_ROLES = ["accounts", "manager", "sales_rep"] as const;

export type BillingQueryStatus = "open" | "resolved";
export type BillingQueryMessageEventType = "message" | "resolved" | "reopened";

export interface BillingQueryAuthor {
  id: string;
  full_name: string;
  role: string;
}

export interface BillingQueryMessage {
  id: string;
  event_type: BillingQueryMessageEventType;
  body: string | null;
  created_by: BillingQueryAuthor;
  created_at: string;
}

/** Lightweight statement context shown alongside a query — same summary
 *  shape the Tally Inbox and History dialog already use. */
export interface BillingQueryStatementSummary {
  id: string;
  statement_number: string | null;
  total_amount: number;
  party_name: string;
  context_label: string; // e.g. "TWV-C-0112 · ZZ-TEST Open Desk v2" or "INV-0025 · Ad-hoc Invoice"
}

export interface BillingQueryListItem {
  id: string;
  status: BillingQueryStatus;
  created_by: BillingQueryAuthor;
  created_at: string;
  updated_at: string;
  resolved_by: BillingQueryAuthor | null;
  resolved_at: string | null;
  statement: BillingQueryStatementSummary;
  /** Most recent message body, for the list-card preview. */
  last_message: { body: string | null; event_type: BillingQueryMessageEventType; created_at: string } | null;
  /** True when the current viewer is the one expected to reply next —
   *  drives the default "Awaiting you" tab. */
  awaiting_viewer: boolean;
}

export interface BillingQueryThread extends Omit<BillingQueryListItem, "last_message"> {
  messages: BillingQueryMessage[];
}

/** Minimal shape of a billing_statements row (plus its owner joins) needed
 *  to resolve a display-ready party name + context label. Mirrors the same
 *  fallback chain tally-inbox-upload-form.tsx uses client-side
 *  (contract → proposal → invoice → case → aggregator), extended to cover
 *  every owner type InboxRow supports. */
export interface StatementOwnerRow {
  id: string;
  statement_number: string | null;
  total_amount: number;
  contract: { contract_number: string; title: string | null; lead: { first_name: string | null; last_name: string | null; company: string | null } | null } | null;
  proposal: { proposal_number: string; lead: { first_name: string | null; last_name: string | null; company: string | null } | null } | null;
  invoice: { invoice_number: string; title: string | null; lead: { first_name: string | null; last_name: string | null; company: string | null } | null } | null;
  case: { case_number: string; client_name: string; client_company_name: string | null } | null;
  aggregator: { name: string } | null;
}

/** Shared Supabase select fragment for the statement-owner joins consumed by
 *  resolveStatementSummary() — one definition, used by all billing-queries
 *  routes so the join shape can't drift between create/list/detail. */
export const STATEMENT_OWNER_SELECT = `
  id, statement_number, total_amount,
  contract:contracts!billing_statements_contract_id_fkey(
    contract_number, title,
    lead:leads!contracts_lead_id_fkey(first_name, last_name, company)
  ),
  proposal:proposals!billing_statements_proposal_id_fkey(
    proposal_number,
    lead:leads!proposals_lead_id_fkey(first_name, last_name, company)
  ),
  invoice:proforma_invoices!billing_statements_invoice_id_fkey(
    invoice_number, title,
    lead:leads!proforma_invoices_lead_id_fkey(first_name, last_name, company)
  ),
  case:cases!billing_statements_case_id_fkey(case_number, client_name, client_company_name),
  aggregator:aggregators!billing_statements_aggregator_id_fkey(name)
`;

export function resolveStatementSummary(row: StatementOwnerRow): BillingQueryStatementSummary {
  const leadName = (lead: { first_name: string | null; last_name: string | null; company: string | null } | null) =>
    lead ? (lead.company || [lead.first_name, lead.last_name].filter(Boolean).join(" ") || null) : null;

  let partyName: string | null = null;
  let contextLabel = "";

  if (row.contract) {
    partyName = leadName(row.contract.lead);
    contextLabel = row.contract.contract_number + (row.contract.title ? ` · ${row.contract.title}` : "");
  } else if (row.proposal) {
    partyName = leadName(row.proposal.lead);
    contextLabel = row.proposal.proposal_number;
  } else if (row.invoice) {
    partyName = leadName(row.invoice.lead);
    contextLabel = row.invoice.invoice_number + " · Ad-hoc Invoice";
  } else if (row.case) {
    partyName = row.case.client_company_name || row.case.client_name;
    contextLabel = row.case.case_number;
  } else if (row.aggregator) {
    partyName = row.aggregator.name;
    contextLabel = "Aggregator statement";
  }

  return {
    id: row.id,
    statement_number: row.statement_number,
    total_amount: row.total_amount,
    party_name: partyName || "(unknown)",
    context_label: contextLabel,
  };
}

/**
 * A query is "awaiting" a viewer when the most recent message wasn't
 * authored by them and the thread is still open — i.e. the ball is in
 * someone else's court and that someone could be this viewer.
 *
 * Kept intentionally simple for v1: any admin/manager/sales_rep counts as
 * a valid responder for any open query (no per-deal assignment yet), so
 * "awaiting you" really means "awaiting someone on your side" for accounts'
 * own questions, and "awaiting you specifically to unblock accounts" for
 * everyone else.
 */
export function isAwaitingViewer(
  status: BillingQueryStatus,
  lastMessageAuthorRole: string,
  viewerRole: string,
): boolean {
  if (status !== "open") return false;
  const askerSide = lastMessageAuthorRole === "accounts";
  const viewerIsAccounts = viewerRole === "accounts";
  // Last word was accounts asking/following up → awaiting a responder.
  // Last word was a responder → awaiting accounts (not this viewer, unless
  // this viewer IS accounts).
  return askerSide ? !viewerIsAccounts : viewerIsAccounts;
}
