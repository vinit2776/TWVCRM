/**
 * QUERY_ENTITIES — one entry per kind of transaction a query can hang off.
 *
 * This is the seam that keeps the Queries module cheap: adding the next
 * surface is an entry here, not a new table, API or page. Each entry says
 * what to call the entity, which Supabase table and columns to read for the
 * summary card, who is authorized on it, and which canned asks to offer.
 *
 * ROLES ARE NOT HAND-CURATED. `roles` starts from the gate that already
 * governs the surface the query is raised from — the same list that decides
 * whether you can open that page at all — extended with any role that can
 * actually *answer* but has no access to that page. Tally Inbox rows are the
 * clear case: accounts raises them, but the floor manager who took the
 * walk-in or the sales rep who agreed the deposit terms is the one who knows,
 * and neither can open the inbox. The original feature had the same
 * asymmetry (BILLING_QUERY_ROLES included sales_rep, INBOX_ROLES never did).
 *
 * There is deliberately no second "default audience" list to drift out of
 * sync: the default is audience: 'all', and 'all' resolves to `roles`
 * (see audience.ts).
 *
 * INVARIANT: alertRoles ⊆ roles. Alerts are a subset of the notified set,
 * which is a subset of the audience, which for 'all' is `roles` — so a role
 * listed only in alertRoles can never actually be paged. Asserted in
 * src/lib/__tests__/queries-audience.test.ts.
 */

import { DEPOSIT_TOPUP_CATEGORY_LABELS, type AuditEntityType, type DepositTopupCategory, type UserRole } from "@/types";
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

// ── booking_gst_task ────────────────────────────────────────────────────────

const BOOKING_TASK_SELECT = `
  id, booking_id,
  booking:bookings!booking_gst_tasks_booking_id_fkey(
    id, booking_number, booking_date, total_amount_with_gst,
    guest_name, guest_company,
    lead:leads!bookings_lead_id_fkey(first_name, last_name, company)
  )
`;

interface BookingTaskRow {
  id: string;
  booking_id: string;
  booking: {
    id: string;
    booking_number: string | null;
    booking_date: string | null;
    total_amount_with_gst: number | null;
    guest_name: string | null;
    guest_company: string | null;
    lead: LeadLike;
  } | null;
}

function bookingTaskSummary(raw: EntityRow): QueryEntitySummary | null {
  const row = raw as unknown as BookingTaskRow;
  if (!row?.id) return null;
  const b = row.booking;

  // Walk-ins carry guest_* directly; contract-holder bookings resolve through
  // the lead. Prefer whichever is actually filled in.
  const party = b?.guest_company || leadName(b?.lead ?? null) || b?.guest_name || "(unknown)";

  return {
    id: row.id,
    title: party,
    // The booking number is the `reference`; repeating it here would render
    // twice on the card.
    subtitle: b?.booking_date ?? "",
    amount: b?.total_amount_with_gst ?? null,
    reference: b?.booking_number ?? null,
    href: b?.id ? `/bookings/${b.id}` : null,
  };
}

// ── proposal_deposit ────────────────────────────────────────────────────────

const PROPOSAL_DEPOSIT_SELECT = `
  id, proposal_number, security_deposit_amount, deposit_payment_amount,
  lead:leads!proposals_lead_id_fkey(first_name, last_name, company)
`;

interface ProposalDepositRow {
  id: string;
  proposal_number: string | null;
  security_deposit_amount: number | null;
  deposit_payment_amount: number | null;
  lead: LeadLike;
}

function proposalDepositSummary(raw: EntityRow): QueryEntitySummary | null {
  const row = raw as unknown as ProposalDepositRow;
  if (!row?.id) return null;
  return {
    id: row.id,
    title: leadName(row.lead) || "(unknown)",
    // Label ("Deposit") and reference (the proposal number) already carry
    // this one; anything more would just repeat them.
    subtitle: "",
    // What was actually received, falling back to what was asked for — the
    // deposit inbox makes the same distinction, since legacy proposals can be
    // marked paid with no amount ever recorded.
    amount: row.deposit_payment_amount ?? row.security_deposit_amount ?? null,
    reference: row.proposal_number,
    href: `/proposals/${row.id}`,
  };
}

// ── deposit_topup ───────────────────────────────────────────────────────────

const DEPOSIT_TOPUP_SELECT = `
  id, amount, category, contract_id,
  contract:contracts!deposit_topups_contract_id_fkey(
    id, contract_number, title,
    lead:leads!contracts_lead_id_fkey(first_name, last_name, company)
  )
`;

interface DepositTopupRow {
  id: string;
  amount: number | null;
  category: string | null;
  contract_id: string;
  contract: { id: string; contract_number: string; title: string | null; lead: LeadLike } | null;
}

function depositTopupSummary(raw: EntityRow): QueryEntitySummary | null {
  const row = raw as unknown as DepositTopupRow;
  if (!row?.id) return null;
  const c = row.contract;
  return {
    id: row.id,
    title: leadName(c?.lead ?? null) || "(unknown)",
    // Why the top-up was collected — genuinely new information, unlike the
    // contract number (the reference) or "Deposit top-up" (the label).
    subtitle: row.category
      ? (DEPOSIT_TOPUP_CATEGORY_LABELS[row.category as DepositTopupCategory] ?? row.category)
      : "",
    amount: row.amount,
    reference: c?.contract_number ?? null,
    href: c?.id ? `/contracts/${c.id}` : null,
  };
}

// ── vendor_bill ─────────────────────────────────────────────────────────────

const VENDOR_BILL_SELECT = `
  id, bill_number, invoice_number, invoice_date, total_amount,
  vendor:procurement_vendors!vendor_bills_vendor_id_fkey(id, name)
`;

interface VendorBillRow {
  id: string;
  bill_number: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total_amount: number | null;
  vendor: { id: string; name: string } | null;
}

function vendorBillSummary(raw: EntityRow): QueryEntitySummary | null {
  const row = raw as unknown as VendorBillRow;
  if (!row?.id) return null;
  return {
    id: row.id,
    title: row.vendor?.name || "(unknown vendor)",
    // The vendor's own invoice number — the thing you'd quote back to them,
    // and distinct from bill_number (the `reference`, which is ours).
    subtitle: row.invoice_number ? `Invoice ${row.invoice_number}` : "",
    amount: row.total_amount,
    reference: row.bill_number,
    href: `/procurement/bills/${row.id}`,
  };
}

// ── contract ────────────────────────────────────────────────────────────────

const CONTRACT_SELECT = `
  id, contract_number, title, total_amount, status,
  lead:leads!contracts_lead_id_fkey(first_name, last_name, company)
`;

interface ContractRow {
  id: string;
  contract_number: string | null;
  title: string | null;
  total_amount: number | null;
  status: string | null;
  lead: LeadLike;
}

function contractSummary(raw: EntityRow): QueryEntitySummary | null {
  const row = raw as unknown as ContractRow;
  if (!row?.id) return null;
  return {
    id: row.id,
    title: leadName(row.lead) || "(unknown)",
    subtitle: row.title ?? "",
    amount: row.total_amount,
    reference: row.contract_number,
    href: `/contracts/${row.id}`,
  };
}

// ── purchase_order ──────────────────────────────────────────────────────────

const PURCHASE_ORDER_SELECT = `
  id, po_number, status, total_amount_with_gst, total_ordered_amount,
  vendor:procurement_vendors!purchase_orders_vendor_id_fkey(name)
`;

interface PurchaseOrderRow {
  id: string;
  po_number: string | null;
  status: string | null;
  total_amount_with_gst: number | null;
  total_ordered_amount: number | null;
  vendor: { name: string } | null;
}

function purchaseOrderSummary(raw: EntityRow): QueryEntitySummary | null {
  const row = raw as unknown as PurchaseOrderRow;
  if (!row?.id) return null;
  return {
    id: row.id,
    title: row.vendor?.name || "(unknown vendor)",
    subtitle: row.status ? row.status.replace(/_/g, " ") : "",
    // GST-inclusive where set; older POs only carry the pre-GST total.
    amount: row.total_amount_with_gst ?? row.total_ordered_amount,
    reference: row.po_number,
    href: `/procurement/orders/${row.id}`,
  };
}

// ── purchase_request ────────────────────────────────────────────────────────

const PURCHASE_REQUEST_SELECT = `
  id, pr_number, status, total_estimated_amount,
  requester:users!purchase_requests_requested_by_fkey(full_name),
  location:locations!purchase_requests_location_id_fkey(name)
`;

interface PurchaseRequestRow {
  id: string;
  pr_number: string | null;
  status: string | null;
  total_estimated_amount: number | null;
  requester: { full_name: string } | null;
  location: { name: string } | null;
}

function purchaseRequestSummary(raw: EntityRow): QueryEntitySummary | null {
  const row = raw as unknown as PurchaseRequestRow;
  if (!row?.id) return null;
  return {
    id: row.id,
    // A material request has no counterparty — the useful "who" is whoever
    // asked for it, since they're who you'd go back to.
    title: row.requester?.full_name || "(unknown requester)",
    subtitle: [row.location?.name, row.status?.replace(/_/g, " ")].filter(Boolean).join(" · "),
    amount: row.total_estimated_amount,
    reference: row.pr_number,
    href: `/procurement/requests/${row.id}`,
  };
}

/** Both procurement surfaces share a gate; office_admin runs procurement and
 *  is the one who can actually answer, so they're paged rather than just
 *  notified. */
const PROCUREMENT_ROLES: readonly UserRole[] = ["admin", "manager", "office_admin", "viewer"];

/**
 * Tally Inbox rows are *raised* by the inbox roles, but frequently *answered*
 * by someone with no inbox access at all — the floor manager who took the
 * walk-in, the sales rep who agreed the deposit terms. So `roles` is the
 * inbox gate plus whoever can actually answer, not the inbox gate alone.
 *
 * This is the same asymmetry the original feature had (BILLING_QUERY_ROLES
 * included sales_rep, who has never been able to open the Tally Inbox), and
 * it's why `roles` is "who is authorized on the query" rather than strictly
 * "who is authorized on the page it was raised from". `alertRoles` must stay
 * a subset — see the registry invariant test.
 */
function inboxRolesPlus(...answerers: UserRole[]): readonly UserRole[] {
  return Array.from(new Set<UserRole>([...(INBOX_ROLES as readonly UserRole[]), ...answerers]));
}

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

  booking_gst_task: {
    type: "booking_gst_task",
    label: "Booking",
    module: "tally_inbox",
    table: "booking_gst_tasks",
    select: BOOKING_TASK_SELECT,
    roles: inboxRolesPlus("floor_manager"),
    // Floor managers took the booking and are the ones who can answer "whose
    // walk-in was this" — they're the point of asking, even though the Tally
    // Inbox itself isn't theirs to open.
    alertRoles: ["accounts", "manager", "floor_manager"],
    auditEntityType: "booking",
    // booking_gst_task has no AuditEntityType of its own; the audit row hangs
    // off the booking, which is the record a person would actually look up.
    auditEntityId: (row) => (row as unknown as BookingTaskRow)?.booking_id ?? null,
    toSummary: bookingTaskSummary,
    templates: [
      {
        key: "which_booking",
        label: "Which booking is this payment against?",
        body: "I can't match the payment received to this booking. Can you confirm which booking it belongs to?",
      },
      {
        key: "walkin_gst",
        label: "Walk-in GST details missing",
        body: "This walk-in has no GST details on file. Do we have them, or should I raise it without?",
      },
      {
        key: "amount_mismatch",
        label: "Amount doesn't match",
        body: "The amount collected doesn't match the booking total. Which figure should I invoice?",
      },
    ],
  },

  proposal_deposit: {
    type: "proposal_deposit",
    label: "Deposit",
    module: "tally_inbox",
    table: "proposals",
    select: PROPOSAL_DEPOSIT_SELECT,
    roles: inboxRolesPlus("sales_rep"),
    // The sales rep who closed the deal knows what was actually agreed on the
    // deposit — waivers, credits and exceptions all originate with them.
    alertRoles: ["accounts", "manager", "sales_rep"],
    auditEntityType: "proposal",
    auditEntityId: (row) => (typeof row?.id === "string" ? row.id : null),
    toSummary: proposalDepositSummary,
    templates: [
      {
        key: "deposit_or_topup",
        label: "Fresh deposit or top-up?",
        body: "Is this a fresh security deposit or a top-up against an existing contract?",
      },
      {
        key: "no_contract_linked",
        label: "No contract linked",
        body: "This deposit is paid but I can't see a contract linked to it. Which contract should it sit against?",
      },
      {
        key: "ref_not_traceable",
        label: "Payment ref not traceable",
        body: "The payment reference on this deposit doesn't match anything in the bank statement. Can you confirm the date it hit, or share the payment screenshot?",
      },
      {
        key: "waiver_or_exception",
        label: "Waiver / exception unclear",
        body: "The deposit collected is less than the contract calls for. Was a waiver or exception approved, and by whom?",
      },
    ],
  },

  deposit_topup: {
    type: "deposit_topup",
    label: "Deposit top-up",
    module: "tally_inbox",
    table: "deposit_topups",
    select: DEPOSIT_TOPUP_SELECT,
    roles: inboxRolesPlus("sales_rep"),
    alertRoles: ["accounts", "manager", "sales_rep"],
    auditEntityType: "contract",
    // Same as booking_gst_task: no AuditEntityType of its own, so the trail
    // hangs off the contract the top-up tops up.
    auditEntityId: (row) => (row as unknown as DepositTopupRow)?.contract_id ?? null,
    toSummary: depositTopupSummary,
    templates: [
      {
        key: "topup_reason",
        label: "What is this top-up for?",
        body: "What was this deposit top-up collected for? The category on it doesn't tell me enough to book it.",
      },
      {
        key: "shortfall",
        label: "Does this clear the shortfall?",
        body: "Does this top-up fully clear the deposit shortfall on the contract, or is more still due?",
      },
      {
        key: "ref_not_traceable",
        label: "Payment ref not traceable",
        body: "The payment reference on this top-up doesn't match anything in the bank statement. Can you confirm the date it hit?",
      },
    ],
  },

  vendor_bill: {
    type: "vendor_bill",
    label: "Vendor Bill",
    module: "payables",
    table: "vendor_bills",
    select: VENDOR_BILL_SELECT,
    // Union of the gates on the two surfaces a bill query is raised from:
    // /accounting (LEGACY_ROLES + accounts) and /procurement/bills.
    roles: ["admin", "manager", "sales_rep", "floor_manager", "accounts", "office_admin", "viewer"],
    // Bills are paid by accounts/admin/office_admin and approved by
    // admin/manager — those are the people who can actually answer. The
    // sales_rep and floor_manager who can *see* /accounting aren't paged.
    alertRoles: ["accounts", "manager", "office_admin"],
    auditEntityType: "vendor_bill",
    auditEntityId: (row) => (typeof row?.id === "string" ? row.id : null),
    toSummary: vendorBillSummary,
    templates: [
      {
        key: "po_mismatch",
        label: "Bill doesn't match the PO",
        body: "The bill total doesn't match the approved PO amount. Which one is right — do I need a revised PO before booking this?",
      },
      {
        key: "tds_section",
        label: "TDS section unclear",
        body: "Which TDS section applies to this bill, and at what rate?",
      },
      {
        key: "duplicate",
        label: "Possible duplicate",
        body: "This looks like it may duplicate a bill already booked for this vendor. Can you confirm before I pay it?",
      },
      {
        key: "gst_missing",
        label: "GST details missing",
        body: "The vendor's GST details are missing or don't match their invoice. Can you confirm the correct ones?",
      },
    ],
  },

  contract: {
    type: "contract",
    label: "Contract",
    module: "contracts",
    table: "contracts",
    select: CONTRACT_SELECT,
    roles: ["admin", "manager", "sales_rep", "floor_manager", "accounts", "viewer"],
    // The sales rep owns the commercial terms; accounts raises most of these.
    alertRoles: ["accounts", "manager", "sales_rep"],
    auditEntityType: "contract",
    auditEntityId: (row) => (typeof row?.id === "string" ? row.id : null),
    toSummary: contractSummary,
    templates: [
      {
        key: "billing_start",
        label: "Billing start date unclear",
        body: "When should billing actually start on this contract? The dates on it don't match what was invoiced.",
      },
      {
        key: "rate_revision",
        label: "Rate revision not reflected",
        body: "A rate revision was agreed but isn't reflected on this contract. Can you confirm the correct rate and from when?",
      },
      {
        key: "deposit_terms",
        label: "Deposit terms unclear",
        body: "What was actually agreed on the security deposit for this contract — was any waiver or carry-forward approved?",
      },
      {
        key: "renewal_intent",
        label: "Renewal intent?",
        body: "This contract is approaching its end date. Is it renewing, and on what terms?",
      },
    ],
  },

  purchase_order: {
    type: "purchase_order",
    label: "Purchase Order",
    module: "procurement",
    table: "purchase_orders",
    select: PURCHASE_ORDER_SELECT,
    roles: PROCUREMENT_ROLES,
    alertRoles: ["admin", "manager", "office_admin"],
    auditEntityType: "purchase_order",
    auditEntityId: (row) => (typeof row?.id === "string" ? row.id : null),
    toSummary: purchaseOrderSummary,
    templates: [
      {
        key: "delivery_mismatch",
        label: "Delivered doesn't match ordered",
        body: "What was delivered doesn't match what this PO ordered. Should I raise a short-receipt, or is a revised PO coming?",
      },
      {
        key: "vendor_changed",
        label: "Vendor changed",
        body: "The bill has come from a different vendor than this PO was raised on. Was that change approved?",
      },
      {
        key: "advance_status",
        label: "Advance payment status",
        body: "What's the status of the advance on this PO — has it been paid, and should it net off the final bill?",
      },
    ],
  },

  purchase_request: {
    type: "purchase_request",
    label: "Material Request",
    module: "procurement",
    table: "purchase_requests",
    select: PURCHASE_REQUEST_SELECT,
    roles: PROCUREMENT_ROLES,
    alertRoles: ["admin", "manager", "office_admin"],
    auditEntityType: "purchase_request",
    auditEntityId: (row) => (typeof row?.id === "string" ? row.id : null),
    toSummary: purchaseRequestSummary,
    templates: [
      {
        key: "spec_unclear",
        label: "Spec or quantity unclear",
        body: "The spec or quantity on this request isn't clear enough to raise a PO against. Can you confirm exactly what's needed?",
      },
      {
        key: "still_needed",
        label: "Still needed?",
        body: "This request has been open a while. Is it still needed, or can it be closed?",
      },
      {
        key: "budget_head",
        label: "Which budget head?",
        body: "Which budget head and location should this be charged to?",
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
