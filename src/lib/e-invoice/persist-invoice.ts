/**
 * DB writers for the gst_invoices + gst_invoice_items tables.
 *
 * Two paths:
 *   1. createGstInvoice() — fresh insert from a validated InternalGstInvoice
 *   2. recordIrnGenerated() / recordIrnCancelled() — state-machine updates
 *      after an IRP call returns
 *
 * Idempotency: createGstInvoice will return the existing row if a tax
 * invoice with the same (seller_gstin, financial_year, doc_type,
 * invoice_number) already exists — so re-runs are safe.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { InternalGstInvoice } from "./types";
import type { NicGenerateIrnSuccess } from "./types";

export interface SourceRef {
  source_type: "booking" | "contract_payment" | "proforma" | "manual";
  source_id?: string;
}

/** Insert a brand-new gst_invoices row + items. Returns the new id. */
export async function createGstInvoice(
  supabase: SupabaseClient,
  inv: InternalGstInvoice,
  source: SourceRef,
  createdBy: string,
): Promise<{ id: string; existed: boolean }> {
  const fy = computeFy(inv.invoice_date);

  // Idempotency: check for an existing tax invoice with the same identity
  const { data: existing } = await supabase
    .from("gst_invoices")
    .select("id")
    .eq("seller_gstin", inv.seller.gstin)
    .eq("financial_year", fy)
    .eq("doc_type", inv.doc_type)
    .eq("invoice_number", inv.invoice_number)
    .maybeSingle();
  if (existing?.id) return { id: existing.id, existed: true };

  // Insert header
  const { data: header, error: hErr } = await supabase
    .from("gst_invoices")
    .insert({
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      doc_type: inv.doc_type,
      financial_year: fy,
      source_type: source.source_type,
      source_id: source.source_id ?? null,
      reference_invoice_number: inv.reference_invoice_number ?? null,
      reference_invoice_date: inv.reference_invoice_date ?? null,
      seller_gstin: inv.seller.gstin,
      seller_legal_name: inv.seller.legal_name,
      seller_trade_name: inv.seller.trade_name ?? null,
      seller_address1: inv.seller.address1,
      seller_address2: inv.seller.address2 ?? null,
      seller_location: inv.seller.location,
      seller_pincode: inv.seller.pincode,
      seller_state_code: inv.seller.state_code,
      buyer_classification: inv.buyer.classification,
      buyer_gstin: inv.buyer.gstin ?? null,
      buyer_legal_name: inv.buyer.legal_name,
      buyer_trade_name: inv.buyer.trade_name ?? null,
      buyer_address1: inv.buyer.address1 ?? null,
      buyer_address2: inv.buyer.address2 ?? null,
      buyer_location: inv.buyer.location ?? null,
      buyer_pincode: inv.buyer.pincode ?? null,
      buyer_state_code: inv.buyer.state_code ?? null,
      place_of_supply_state_code: inv.place_of_supply_state_code,
      is_intrastate: inv.is_intrastate,
      currency: inv.currency,
      total_taxable_value: inv.total_taxable_value,
      total_cgst_amount: inv.total_cgst_amount,
      total_sgst_amount: inv.total_sgst_amount,
      total_igst_amount: inv.total_igst_amount,
      total_cess_amount: inv.total_cess_amount,
      total_discount: inv.total_discount,
      total_other_charges: inv.total_other_charges,
      round_off_amount: inv.round_off_amount,
      total_invoice_value: inv.total_invoice_value,
      e_invoice_status: inv.buyer.classification === "b2b" ? "pending" : "not_applicable",
      notes: inv.remarks ?? null,
      created_by: createdBy,
    })
    .select("id")
    .single();

  if (hErr || !header) throw new Error(`Failed to insert gst_invoice: ${hErr?.message ?? "unknown"}`);

  // Insert items
  const itemRows = inv.items.map((it) => ({
    gst_invoice_id: header.id,
    serial_no: it.serial_no,
    is_service: it.is_service,
    hsn_or_sac_code: it.hsn_or_sac_code,
    item_description: it.item_description,
    unit: it.unit ?? null,
    quantity: it.quantity,
    unit_price: it.unit_price,
    gross_amount: it.gross_amount,
    discount_amount: it.discount_amount,
    other_charges: it.other_charges,
    taxable_value: it.taxable_value,
    gst_rate: it.gst_rate,
    cgst_amount: it.cgst_amount,
    sgst_amount: it.sgst_amount,
    igst_amount: it.igst_amount,
    cess_rate: it.cess_rate,
    cess_amount: it.cess_amount,
    total_item_value: it.total_item_value,
  }));

  const { error: iErr } = await supabase.from("gst_invoice_items").insert(itemRows);
  if (iErr) {
    // Roll back the header so we don't leave an orphan
    await supabase.from("gst_invoices").delete().eq("id", header.id);
    throw new Error(`Failed to insert line items: ${iErr.message}`);
  }

  // Cross-reference back to the source entity (best-effort, non-fatal)
  if (source.source_id) {
    if (source.source_type === "booking") {
      await supabase.from("bookings").update({ gst_invoice_id: header.id }).eq("id", source.source_id);
    } else if (source.source_type === "contract_payment") {
      await supabase.from("contract_payments").update({ gst_invoice_id: header.id }).eq("id", source.source_id);
    }
  }

  return { id: header.id, existed: false };
}

/** Persist a successful IRN generation back to the gst_invoices row. */
export async function recordIrnGenerated(
  supabase: SupabaseClient,
  gstInvoiceId: string,
  irpResponse: NicGenerateIrnSuccess,
  meta: { irp_used: string; environment: "sandbox" | "production" },
): Promise<void> {
  const { error } = await supabase
    .from("gst_invoices")
    .update({
      e_invoice_status: "generated",
      irn: irpResponse.Irn,
      ack_no: String(irpResponse.AckNo),
      ack_date: parseIrpTimestamp(irpResponse.AckDt),
      signed_invoice_jwt: irpResponse.SignedInvoice,
      signed_qr_code: irpResponse.SignedQRCode,
      e_invoice_generated_at: new Date().toISOString(),
      irp_used: meta.irp_used,
      e_invoice_environment: meta.environment,
      e_invoice_last_error_code: null,
      e_invoice_last_error_message: null,
    })
    .eq("id", gstInvoiceId);
  if (error) throw new Error(`Failed to record IRN: ${error.message}`);
}

/** Persist a failed IRN attempt — increments attempt counter, captures error. */
export async function recordIrnFailure(
  supabase: SupabaseClient,
  gstInvoiceId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  const { data: row } = await supabase
    .from("gst_invoices")
    .select("e_invoice_attempt_count")
    .eq("id", gstInvoiceId)
    .single();
  const next = (row?.e_invoice_attempt_count ?? 0) + 1;

  await supabase
    .from("gst_invoices")
    .update({
      e_invoice_status: "failed",
      e_invoice_attempt_count: next,
      e_invoice_last_error_code: errorCode,
      e_invoice_last_error_message: errorMessage,
    })
    .eq("id", gstInvoiceId);
}

/** Persist a successful IRN cancellation. */
export async function recordIrnCancelled(
  supabase: SupabaseClient,
  gstInvoiceId: string,
  reasonCode: "1" | "2" | "3" | "4",
  remarks: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("gst_invoices")
    .update({
      e_invoice_status: "cancelled",
      e_invoice_cancelled_at: new Date().toISOString(),
      e_invoice_cancellation_reason_code: reasonCode,
      e_invoice_cancellation_remarks: remarks,
    })
    .eq("id", gstInvoiceId);
  if (error) throw new Error(`Failed to record cancellation: ${error.message}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** "2026-05-07" → "2026-27" (Indian FY: April → March) */
function computeFy(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  if (m >= 4) return `${y}-${String(y + 1).slice(2)}`;
  return `${y - 1}-${String(y).slice(2)}`;
}

/** "2026-05-07 14:32:01" (IST) → ISO UTC */
function parseIrpTimestamp(ts: string | undefined): string | null {
  if (!ts) return null;
  const [d, t] = ts.split(" ");
  if (!d || !t) return null;
  return new Date(`${d}T${t}+05:30`).toISOString();
}
