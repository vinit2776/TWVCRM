import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { applyBillFilters, resolveFreeTextIds } from "@/lib/bills-query";

/**
 * GET /api/procurement/bills/export?<same filters as list>
 *
 * Returns a CSV file containing the bills matching the current filters.
 * Capped at 5000 rows to protect the API gateway.
 *
 * Same auth + filter semantics as the bills list endpoint.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser) return new Response("Forbidden", { status: 403 });

  const { searchParams } = new URL(request.url);
  const { vendorIds, poIds } = await resolveFreeTextIds(supabase, searchParams.get("q"));

  let query = supabase
    .from("vendor_bills")
    .select(
      `id, bill_number, invoice_number, invoice_date, due_date,
       total_amount, amount_paid, approved_amount, approval_status, payment_status,
       payment_mode, payment_date, payment_reference,
       payment_batch_type, payment_batch_date,
       approval_code, approved_at, rejection_reason, rejection_outcome,
       notes, created_at,
       procurement_vendors(name, gstin, contact_email),
       purchase_orders(po_number),
       approver:users!vendor_bills_approved_by_fkey(full_name)`
    )
    .order("created_at", { ascending: false })
    .limit(5000);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query = applyBillFilters(query as any, searchParams, { vendorIdsFromQ: vendorIds, poIdsFromQ: poIds }) as typeof query;

  const { data, error } = await query;
  if (error) return new Response(`Error: ${error.message}`, { status: 500 });

  // ── CSV ──
  const headers = [
    "Bill #", "Invoice #", "Invoice Date", "Due Date",
    "Vendor", "Vendor GSTIN", "Vendor Email",
    "PO #",
    "Total", "Amount Paid", "Approved Amount", "Balance",
    "Approval Status", "Approved By", "Approved At", "Approval Code",
    "Payment Status", "Payment Mode", "Payment Date", "Payment Reference",
    "Batch Type", "Batch Date",
    "Rejection Reason", "Rejection Outcome",
    "Notes", "Created At",
  ];

  type Joined = {
    procurement_vendors?: { name?: string; gstin?: string; contact_email?: string } | { name?: string; gstin?: string; contact_email?: string }[] | null;
    purchase_orders?: { po_number?: string } | { po_number?: string }[] | null;
    approver?: { full_name?: string } | { full_name?: string }[] | null;
  };
  const pick = <T,>(joined: T | T[] | null | undefined): T | null => {
    if (!joined) return null;
    return Array.isArray(joined) ? joined[0] ?? null : joined;
  };

  const rows = (data ?? []).map((b) => {
    const r = b as Record<string, unknown> & Joined;
    const vendor = pick(r.procurement_vendors);
    const po = pick(r.purchase_orders);
    const approver = pick(r.approver);
    const total = Number(r.total_amount ?? 0);
    const paid = Number(r.amount_paid ?? 0);
    return [
      r.bill_number,
      r.invoice_number,
      r.invoice_date,
      r.due_date,
      vendor?.name,
      vendor?.gstin,
      vendor?.contact_email,
      po?.po_number,
      total,
      paid,
      r.approved_amount,
      total - paid,
      r.approval_status,
      approver?.full_name,
      r.approved_at,
      r.approval_code,
      r.payment_status,
      r.payment_mode,
      r.payment_date,
      r.payment_reference,
      r.payment_batch_type,
      r.payment_batch_date,
      r.rejection_reason,
      r.rejection_outcome,
      r.notes,
      r.created_at,
    ];
  });

  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (s.includes('"') || s.includes(",") || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const csv = [headers, ...rows]
    .map((row) => row.map(esc).join(","))
    .join("\n");

  const today = new Date().toISOString().split("T")[0];
  const filename = `vendor-bills-${today}.csv`;

  // Excel assumes the system codepage without a BOM, which mangles ₹ and any
  // non-ASCII character (e.g. the "—" placeholder) into junk like "â€"".
  return new Response("﻿" + csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
