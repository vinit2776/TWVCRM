/**
 * Bill search — URL state ↔ filter object helpers + Supabase query builder.
 *
 * Used by:
 *   - <BillSearchBar> component to read/write filters from URL
 *   - /api/procurement/bills GET to translate URL params to DB queries
 *   - /api/procurement/bills/export to share the same filter logic
 *
 * Pattern: filters live in URL query string so every search is
 * bookmarkable / shareable. Empty values are stripped to keep URLs short.
 */

export type BillApprovalFilter = "" | "pending" | "approved" | "rejected";
export type BillPaymentFilter = "" | "unpaid" | "partially_paid" | "paid";
export type BillPaymentBatchTypeFilter = "" | "immediate" | "15th" | "25th";
export type HasIrnFilter = "" | "true" | "false";

export interface BillFilters {
  /** Free-text search across bill #, invoice #, approval_code, vendor name/GSTIN, PO #, notes, rejection_reason */
  q: string;

  // Identity / status
  approval_status: BillApprovalFilter;
  payment_status: BillPaymentFilter;
  payment_status_neq: BillPaymentFilter;  // shortcut for "anything not paid"
  has_irn: HasIrnFilter;
  rejection_outcome: string;               // "return" | "replacement" | "void" | ""

  // Vendor / PO scoping
  vendor_id: string;
  po_id: string;

  // Company scoping (multi-company procurement)
  company_id: string;

  // Money
  min_amount: string;       // strings to preserve URL semantics; coerced when used
  max_amount: string;
  min_approved_amount: string;
  max_approved_amount: string;

  // Dates (YYYY-MM-DD)
  invoice_date_from: string;
  invoice_date_to: string;
  due_date_from: string;
  due_date_to: string;
  approved_date_from: string;
  approved_date_to: string;
  payment_date_from: string;
  payment_date_to: string;
  created_date_from: string;
  created_date_to: string;

  // People
  approver_id: string;

  // Payment batch
  payment_batch_type: BillPaymentBatchTypeFilter;
  payment_batch_date_from: string;
  payment_batch_date_to: string;

  // Pagination
  page: string;
  limit: string;
}

export const EMPTY_FILTERS: BillFilters = {
  q: "",
  approval_status: "",
  payment_status: "",
  payment_status_neq: "",
  has_irn: "",
  rejection_outcome: "",
  vendor_id: "",
  po_id: "",
  company_id: "",
  min_amount: "",
  max_amount: "",
  min_approved_amount: "",
  max_approved_amount: "",
  invoice_date_from: "",
  invoice_date_to: "",
  due_date_from: "",
  due_date_to: "",
  approved_date_from: "",
  approved_date_to: "",
  payment_date_from: "",
  payment_date_to: "",
  created_date_from: "",
  created_date_to: "",
  approver_id: "",
  payment_batch_type: "",
  payment_batch_date_from: "",
  payment_batch_date_to: "",
  page: "1",
  limit: "25",
};

/** Parse URLSearchParams (or any record-like) into a BillFilters object. */
export function parseBillFilters(params: URLSearchParams | Record<string, string>): BillFilters {
  const get = (k: string): string => {
    if (params instanceof URLSearchParams) return params.get(k) ?? "";
    return params[k] ?? "";
  };
  // Build by iterating keys of EMPTY_FILTERS so we never miss/add silently.
  // Cast through Record<string,string> to avoid TS's complaint about narrow
  // literal types (BillFilters has fields typed as e.g. "" | "pending" | …).
  const out = { ...EMPTY_FILTERS } as BillFilters;
  const writable = out as unknown as Record<string, string>;
  (Object.keys(EMPTY_FILTERS) as Array<keyof BillFilters>).forEach((k) => {
    const v = get(k);
    if (v) writable[k] = v;
  });
  return out;
}

/** Serialize filters to a URLSearchParams, omitting empty values. */
export function filtersToParams(filters: Partial<BillFilters>): URLSearchParams {
  const sp = new URLSearchParams();
  (Object.entries(filters) as Array<[keyof BillFilters, string]>).forEach(([k, v]) => {
    if (v && v !== "") sp.set(k, String(v));
  });
  return sp;
}

/** Count active filters (excludes pagination + base scoping). */
export function countActiveFilters(filters: BillFilters): number {
  const ignored = new Set<keyof BillFilters>(["page", "limit", "q"]);
  let n = 0;
  (Object.keys(filters) as Array<keyof BillFilters>).forEach((k) => {
    if (ignored.has(k)) return;
    if (filters[k] && filters[k] !== "") n++;
  });
  return n;
}

/** Returns true if any filter (including q) is set. */
export function hasAnyFilter(filters: BillFilters): boolean {
  return !!filters.q || countActiveFilters(filters) > 0;
}

/**
 * Active filter chips for display above the table.
 * Each chip knows its key so a "clear this filter" button can dispatch the right reset.
 */
export interface FilterChip {
  key: keyof BillFilters;
  label: string;
}

export function describeFilterChips(filters: BillFilters, lookups?: {
  vendors?: Record<string, string>;       // vendor_id → name
  approvers?: Record<string, string>;     // user_id → full_name
  companies?: Record<string, string>;     // company_id → brand_name
}): FilterChip[] {
  const chips: FilterChip[] = [];
  const push = (key: keyof BillFilters, label: string) => chips.push({ key, label });

  if (filters.approval_status) push("approval_status", `Approval: ${filters.approval_status}`);
  if (filters.payment_status) push("payment_status", `Payment: ${filters.payment_status.replace("_", " ")}`);
  if (filters.payment_status_neq) push("payment_status_neq", `Payment ≠ ${filters.payment_status_neq.replace("_", " ")}`);
  if (filters.has_irn === "true") push("has_irn", "Has IRN");
  if (filters.has_irn === "false") push("has_irn", "No IRN");
  if (filters.rejection_outcome) push("rejection_outcome", `Rejection: ${filters.rejection_outcome}`);

  if (filters.vendor_id) {
    const name = lookups?.vendors?.[filters.vendor_id];
    push("vendor_id", `Vendor: ${name ?? filters.vendor_id.slice(0, 8)}`);
  }
  if (filters.approver_id) {
    const name = lookups?.approvers?.[filters.approver_id];
    push("approver_id", `Approver: ${name ?? filters.approver_id.slice(0, 8)}`);
  }
  if (filters.company_id) {
    const name = lookups?.companies?.[filters.company_id];
    push("company_id", `Company: ${name ?? filters.company_id.slice(0, 8)}`);
  }

  if (filters.min_amount || filters.max_amount) {
    const lo = filters.min_amount ? `₹${Number(filters.min_amount).toLocaleString("en-IN")}` : "—";
    const hi = filters.max_amount ? `₹${Number(filters.max_amount).toLocaleString("en-IN")}` : "—";
    push("min_amount", `Amount: ${lo} → ${hi}`);
  }

  const dateRange = (from: string, to: string, label: string, key: keyof BillFilters) => {
    if (!from && !to) return;
    push(key, `${label}: ${from || "—"} → ${to || "—"}`);
  };
  dateRange(filters.invoice_date_from, filters.invoice_date_to, "Invoice date", "invoice_date_from");
  dateRange(filters.due_date_from, filters.due_date_to, "Due date", "due_date_from");
  dateRange(filters.approved_date_from, filters.approved_date_to, "Approved", "approved_date_from");
  dateRange(filters.payment_date_from, filters.payment_date_to, "Paid", "payment_date_from");
  dateRange(filters.created_date_from, filters.created_date_to, "Created", "created_date_from");

  if (filters.payment_batch_type) push("payment_batch_type", `Batch: ${filters.payment_batch_type}`);
  dateRange(filters.payment_batch_date_from, filters.payment_batch_date_to, "Batch date", "payment_batch_date_from");

  return chips;
}

/** Reset paired filters when clearing a chip (e.g. clearing a date range clears both endpoints). */
export const CHIP_RESET_GROUPS: Record<string, Array<keyof BillFilters>> = {
  min_amount: ["min_amount", "max_amount"],
  invoice_date_from: ["invoice_date_from", "invoice_date_to"],
  due_date_from: ["due_date_from", "due_date_to"],
  approved_date_from: ["approved_date_from", "approved_date_to"],
  payment_date_from: ["payment_date_from", "payment_date_to"],
  created_date_from: ["created_date_from", "created_date_to"],
  payment_batch_date_from: ["payment_batch_date_from", "payment_batch_date_to"],
};
