/**
 * Why an invoice exists — the stamp shown on every Tally Inbox card so accounts can
 * tell a monthly rent invoice from a reimbursement or an ad hoc one at a glance.
 *
 * Derived, not stored: it reads what the statement is linked to and its
 * statement_type. Returns null when nothing identifies it (no stamp is better than
 * a wrong one).
 */
export type InvoiceReasonGroup = "recurring" | "one_off" | "virtual_office";

export interface InvoiceReason {
  key: string;
  label: string;
  group: InvoiceReasonGroup;
  /** One line shown as the tooltip. */
  hint: string;
}

interface ReasonSource {
  line_items?: { statement_type?: string | null } | null;
  contract?: unknown | null;
  proposal?: unknown | null;
  invoice?: unknown | null;
}

const BY_TYPE: Record<string, InvoiceReason> = {
  rent: { key: "rent", label: "Monthly rent", group: "recurring", hint: "Recurring monthly rent for an active contract" },
  usage: { key: "usage", label: "Usage and services", group: "recurring", hint: "Prints, services and extras billed in arrears" },
  combined: { key: "combined", label: "Rent + usage", group: "recurring", hint: "Monthly rent and usage on one invoice" },
  electricity: { key: "electricity", label: "Electricity", group: "recurring", hint: "Electricity re-bill from the meter reading" },
  reimbursement: { key: "reimbursement", label: "Reimbursement", group: "one_off", hint: "A purchase re-billed to the customer at cost" },
  vo_renewal: { key: "vo_renewal", label: "Virtual Office · Renewal", group: "virtual_office", hint: "Virtual Office renewal" },
  vo_case: { key: "vo_case", label: "Virtual Office", group: "virtual_office", hint: "Virtual Office case invoice" },
  vo_aggregator_consolidated: { key: "vo_aggregator", label: "Virtual Office · Aggregator", group: "virtual_office", hint: "Consolidated invoice for an aggregator's Virtual Office cases" },
};

export function invoiceReasonFor(row: ReasonSource): InvoiceReason | null {
  const type = row.line_items?.statement_type ?? null;
  // Types that say what the invoice is on their own come first.
  if (type && (type.startsWith("vo_") || type === "reimbursement" || type === "electricity")) {
    return BY_TYPE[type] ?? null;
  }
  if (row.invoice) {
    return { key: "ad_hoc", label: "Ad hoc invoice", group: "one_off", hint: "A one-off invoice raised by hand" };
  }
  // A proposal-owned statement with no contract yet is the first, partial month.
  if (row.proposal && !row.contract) {
    return { key: "first_month", label: "First month (pro-rata)", group: "one_off", hint: "First partial month collected with the proposal" };
  }
  return type ? BY_TYPE[type] ?? null : null;
}
