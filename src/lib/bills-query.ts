/**
 * Server-only helpers for applying bill-search filters to Supabase queries.
 *
 * Used by:
 *   - GET /api/procurement/bills
 *   - GET /api/procurement/bills/export
 *
 * Pure functions — no auth, no logging. Caller wraps with auth + audit.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

interface FilterableQuery {
  eq: (col: string, val: unknown) => FilterableQuery;
  neq: (col: string, val: unknown) => FilterableQuery;
  gte: (col: string, val: unknown) => FilterableQuery;
  lte: (col: string, val: unknown) => FilterableQuery;
  in: (col: string, vals: unknown[]) => FilterableQuery;
  is: (col: string, val: unknown) => FilterableQuery;
  not: (col: string, op: string, val: unknown) => FilterableQuery;
  or: (filters: string) => FilterableQuery;
}

/**
 * Applies bill-search filters to a Supabase query builder.
 * Free-text resolution happens upstream in resolveFreeTextIds().
 */
export function applyBillFilters<Q extends FilterableQuery>(
  query: Q,
  sp: URLSearchParams,
  opts: { vendorIdsFromQ?: string[]; poIdsFromQ?: string[] },
): Q {
  const get = (k: string) => sp.get(k);

  if (get("payment_status"))     query = query.eq("payment_status", get("payment_status")) as Q;
  if (get("payment_status_neq")) query = query.neq("payment_status", get("payment_status_neq")) as Q;
  if (get("approval_status"))    query = query.eq("approval_status", get("approval_status")) as Q;
  if (get("vendor_id"))          query = query.eq("vendor_id", get("vendor_id")) as Q;
  if (get("po_id"))              query = query.eq("po_id", get("po_id")) as Q;
  if (get("company_id"))         query = query.eq("company_id", get("company_id")) as Q;

  if (get("has_irn") === "true")  query = query.not("approval_code", "is", null) as Q;
  if (get("has_irn") === "false") query = query.is("approval_code", null) as Q;

  if (get("rejection_outcome"))  query = query.eq("rejection_outcome", get("rejection_outcome")) as Q;
  if (get("approver_id"))        query = query.eq("approved_by", get("approver_id")) as Q;

  // Numeric ranges
  const numCol = (col: string, fromKey: string, toKey: string) => {
    const from = get(fromKey);
    const to = get(toKey);
    if (from) query = query.gte(col, Number(from)) as Q;
    if (to)   query = query.lte(col, Number(to)) as Q;
  };
  numCol("total_amount",     "min_amount",          "max_amount");
  numCol("approved_amount",  "min_approved_amount", "max_approved_amount");

  // Date ranges
  const dateCol = (col: string, fromKey: string, toKey: string) => {
    const from = get(fromKey);
    const to = get(toKey);
    if (from) query = query.gte(col, from) as Q;
    if (to)   query = query.lte(col, to) as Q;
  };
  dateCol("invoice_date",      "invoice_date_from",      "invoice_date_to");
  dateCol("due_date",          "due_date_from",          "due_date_to");
  dateCol("approved_at",       "approved_date_from",     "approved_date_to");
  dateCol("payment_date",      "payment_date_from",      "payment_date_to");
  dateCol("created_at",        "created_date_from",      "created_date_to");
  dateCol("payment_batch_date","payment_batch_date_from","payment_batch_date_to");

  if (get("payment_batch_type")) query = query.eq("payment_batch_type", get("payment_batch_type")) as Q;

  // Free-text OR composite
  const q = get("q")?.trim();
  if (q) {
    const escaped = q.replace(/[%_]/g, (c) => "\\" + c);
    const like = `%${escaped}%`;
    const orParts: string[] = [
      `bill_number.ilike.${like}`,
      `invoice_number.ilike.${like}`,
      `approval_code.ilike.${like}`,
      `notes.ilike.${like}`,
      `approved_amount_note.ilike.${like}`,
      `rejection_reason.ilike.${like}`,
    ];
    if (opts.vendorIdsFromQ?.length) orParts.push(`vendor_id.in.(${opts.vendorIdsFromQ.join(",")})`);
    if (opts.poIdsFromQ?.length)     orParts.push(`po_id.in.(${opts.poIdsFromQ.join(",")})`);
    query = query.or(orParts.join(",")) as Q;
  }

  return query;
}

/**
 * Resolve a free-text query into vendor + PO IDs (separate small lookups
 * since Supabase can't OR across joined tables in a single query).
 */
export async function resolveFreeTextIds(
  supabase: SupabaseClient,
  q: string | null,
): Promise<{ vendorIds: string[]; poIds: string[] }> {
  if (!q || !q.trim()) return { vendorIds: [], poIds: [] };
  const escaped = q.replace(/[%_]/g, (c) => "\\" + c);
  const like = `%${escaped}%`;

  const [vendorRes, poRes] = await Promise.all([
    supabase
      .from("procurement_vendors")
      .select("id")
      .or(`name.ilike.${like},gstin.ilike.${like},contact_name.ilike.${like}`)
      .limit(200),
    supabase
      .from("purchase_orders")
      .select("id")
      .ilike("po_number", like)
      .limit(200),
  ]);
  return {
    vendorIds: (vendorRes.data ?? []).map((v: { id: string }) => v.id),
    poIds: (poRes.data ?? []).map((p: { id: string }) => p.id),
  };
}
