/**
 * QUERY_ENTITIES — one entry per kind of transaction a query can hang off.
 *
 * This is the seam that keeps the Queries module cheap: adding the next
 * surface is an entry here, not a new table, API or page. Each entry says
 * what to call the entity, which Supabase table and columns to read for the
 * summary card, who is authorized on it, and which canned asks to offer.
 *
 * ROLES ARE NOT HAND-CURATED. `roles` reuses the gate that already governs
 * the surface the query is raised from — the same list that decides whether
 * you can open that page at all. There is deliberately no second
 * "default audience" list to drift out of sync: the default is
 * audience: 'all', and 'all' resolves to `roles` (see audience.ts).
 */

import type { AuditEntityType, UserRole } from "@/types";
import { INBOX_ROLES } from "@/lib/tally-handoff";
import type { QueryEntityType, QueryEntitySummary, QueryModule, QueryTemplate } from "./types";

export interface QueryEntityDef {
  type: QueryEntityType;
  /** Singular, shown on cards: "Statement", "Vendor Bill". */
  label: string;
  module: QueryModule;
  /** Supabase table the summary is read from. */
  table: string;
  /** Select fragment passed to .select() to build the summary. */
  select: string;
  /**
   * Every role authorized on the surface(s) this query is raised from.
   * Governs visibility, and is what audience: 'all' resolves to (minus
   * read-only roles — see READ_ONLY_ROLES in audience.ts).
   */
  roles: readonly UserRole[];
  /**
   * The narrower set that gets *paged* (email / WhatsApp escalation) on an
   * untargeted query, as opposed to merely notified in-app. Carried over
   * from BILLING_QUERY_ALERT_ROLES (#433): admin and office_admin can see
   * and act on every thread but are monitoring, not on the hook to answer.
   *
   * This applies to audience: 'all' only. When an asker explicitly targets
   * roles or people, that beats the monitoring distinction — if you were
   * addressed by name you get the email, whoever you are.
   */
  alertRoles: readonly UserRole[];
  templates: QueryTemplate[];
  auditEntityType: AuditEntityType;
  /**
   * Which record the audit row hangs off. Usually the entity itself, but for
   * entity types with no AuditEntityType of their own (booking_gst_task,
   * deposit_topup) this returns the parent — the record a person would
   * actually look up. Returns null when the row can't be resolved.
   */
  auditEntityId(row: EntityRow): string | null;
  /** Display fields only. Returns null when the transaction is gone. */
  toSummary(row: EntityRow): QueryEntitySummary | null;
}

/** Rows come back from Supabase loosely typed; each toSummary narrows its own. */
export type EntityRow = Record<string, unknown>;

// ── billing_statement ───────────────────────────────────────────────────────

type LeadLike = { first_name: string | null; last_name: string | null; company: string | null } | null;

function leadName(lead: LeadLike): string | null {
  if (!lead) return null;
  return lead.company || [lead.first_name, lead.last_name].filter(Boolean).join(" ") || null;
}

/**
 * Owner-join fragment for billing_statements. A statement can be owned by any
 * one of five things; this mirrors the same fallback chain the Tally Inbox
 * upload form uses client-side (contract → proposal → invoice → case →
 * aggregator). Moved here from the old src/lib/billing-queries.ts.
 */
const STATEMENT_SELECT = `
  id, statement_number, total_amount,
  contract:contracts!billing_statements_contract_id_fkey(
    id, contract_number, title,
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

interface StatementRow {
  id: string;
  statement_number: string | null;
  total_amount: number;
  contract: { id: string; contract_number: string; title: string | null; lead: LeadLike } | null;
  proposal: { proposal_number: string; lead: LeadLike } | null;
  invoice: { invoice_number: string; title: string | null; lead: LeadLike } | null;
  case: { case_number: string; client_name: string; client_company_name: string | null } | null;
  aggregator: { name: string } | null;
}

function statementSummary(raw: EntityRow): QueryEntitySummary | null {
  const row = raw as unknown as StatementRow;
  if (!row?.id) return null;

  let title: string | null = null;
  let subtitle = "";
  let href: string | null = null;

  if (row.contract) {
    title = leadName(row.contract.lead);
    subtitle = row.contract.contract_number + (row.contract.title ? ` · ${row.contract.title}` : "");
    href = `/contracts/${row.contract.id}`;
  } else if (row.proposal) {
    title = leadName(row.proposal.lead);
    subtitle = row.proposal.proposal_number;
  } else if (row.invoice) {
    title = leadName(row.invoice.lead);
    subtitle = `${row.invoice.invoice_number} · Ad-hoc Invoice`;
  } else if (row.case) {
    title = row.case.client_company_name || row.case.client_name;
    subtitle = row.case.case_number;
  } else if (row.aggregator) {
    title = row.aggregator.name;
    subtitle = "Aggregator statement";
  }

  return {
    id: row.id,
    title: title || "(unknown)",
    subtitle,
    amount: row.total_amount,
    reference: row.statement_number,
    href,
  };
}

/**
 * Roles authorized on the surfaces a statement query is raised from:
 * /billing and /accounting/receivables (LEGACY_ROLES + accounts) plus the
 * Tally Inbox (INBOX_ROLES). Union, deduped below.
 */
const STATEMENT_ROLES = Array.from(
  new Set<UserRole>([
    "admin",
    "manager",
    "sales_rep",
    "floor_manager",
    "accounts",
    "viewer",
    ...(INBOX_ROLES as readonly UserRole[]),
  ]),
);

export const QUERY_ENTITIES: Record<QueryEntityType, QueryEntityDef> = {
  billing_statement: {
    type: "billing_statement",
    label: "Statement",
    module: "billing",
    table: "billing_statements",
    select: STATEMENT_SELECT,
    roles: STATEMENT_ROLES,
    alertRoles: ["accounts", "manager", "sales_rep"],
    auditEntityType: "billing_statement",
    auditEntityId: (row) => (typeof row?.id === "string" ? row.id : null),
    toSummary: statementSummary,
    templates: [
      {
        key: "ledger_head",
        label: "Which ledger head?",
        body: "Which ledger head should this be booked to in Tally?",
      },
      {
        key: "rate_mismatch",
        label: "Rate mismatch vs contract",
        body: "The rate on this statement doesn't match the contract. Which one is correct?",
      },
      {
        key: "usage_spike",
        label: "Usage looks unusual",
        body: "The usage charges on this statement look unusual against last month. Confirm before I send the invoice?",
      },
      {
        key: "gst_details",
        label: "Customer GST details missing",
        body: "The customer's GST details are missing or don't match. Can you confirm the correct ones?",
      },
    ],
  },
};

export function queryEntityDef(type: string): QueryEntityDef | null {
  return (QUERY_ENTITIES as Record<string, QueryEntityDef | undefined>)[type] ?? null;
}

/** Every role authorized on at least one entity type — the gate for /queries
 *  itself. Someone with none of these has no reason to see the page. */
export const ANY_QUERY_ROLE: readonly UserRole[] = Array.from(
  new Set(Object.values(QUERY_ENTITIES).flatMap((d) => d.roles)),
);

export function isQueryUser(role: string | null | undefined): role is UserRole {
  return !!role && (ANY_QUERY_ROLE as readonly string[]).includes(role);
}
