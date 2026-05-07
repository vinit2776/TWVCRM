/**
 * Constructs an InternalGstInvoice from application source entities
 * (a booking_payment, contract_payment, or proforma_invoice).
 *
 * Pure logic — no I/O. The caller passes already-loaded source rows.
 *
 * The output is shape-validated by validateForIrn() and ready to be
 * persisted via persist-invoice.ts and submitted to the IRP via the
 * generate-irn route.
 */

import type { InternalGstInvoice, InternalGstInvoiceItem } from "./types";
import type { EInvoicePublicConfig } from "./settings-loader";
import { isIntrastate, stateCodeFromGstin } from "./place-of-supply";
import { DEFAULT_COWORKING_SAC, DEFAULT_GST_RATE, NIC_UNIT_CODES } from "./sac-codes";

// ─── Source-entity shapes (intentionally minimal) ────────────────────────────

export interface BuilderSeller {
  gstin: string;
  legal_name: string;
  trade_name?: string;
  address1: string;
  address2?: string;
  location: string;
  pincode: string;
  state_code: string;
  phone?: string;
  email?: string;
}

export interface BuilderBuyer {
  // Mandatory
  legal_name: string;       // company name preferred, else "first_name last_name"
  // GSTIN — if present and valid, classification = b2b
  gstin?: string | null;
  // Address (optional for B2C; required for B2B)
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  state_code?: string | null;   // 2-digit code, derived from GSTIN if not given
  pincode?: string | null;
  // Contact
  phone?: string | null;
  email?: string | null;
}

export interface BuilderLineItem {
  description: string;          // e.g. "Coworking — May 2026"
  hsn_or_sac_code?: string;     // defaults to seller's default (997212)
  unit?: string;                // NIC 3-char code; defaults to MON for monthly
  quantity?: number;            // default 1
  unit_price: number;           // pre-tax per-unit price
  discount_amount?: number;     // line-level discount
  gst_rate?: number;            // defaults to seller's default (18)
  is_service?: boolean;         // defaults to true (co-working is services)
}

export interface BuilderInput {
  doc_type: "INV" | "CRN" | "DBN";
  invoice_number: string;
  invoice_date: string;         // YYYY-MM-DD
  reference_invoice_number?: string;
  reference_invoice_date?: string;
  seller: BuilderSeller;
  buyer: BuilderBuyer;
  items: BuilderLineItem[];
  remarks?: string;
}

// ─── Builder ─────────────────────────────────────────────────────────────────

/**
 * Build an InternalGstInvoice with all line totals + header totals computed.
 * Throws if input is malformed (no items, missing seller GSTIN, etc.).
 *
 * Math conventions:
 *   - taxable_value = (quantity × unit_price) - discount_amount
 *   - cgst = sgst = (taxable × gst_rate / 2) / 100   [intrastate]
 *   - igst = (taxable × gst_rate) / 100              [interstate]
 *   - total_item_value = taxable + tax + cess + other_charges
 *   - All money is rounded to 2 decimal places at the line level
 *   - round_off_amount captures the difference if final total is not a whole rupee
 */
export function buildGstInvoice(input: BuilderInput, defaults?: { sac_code?: string; gst_rate?: number }): InternalGstInvoice {
  if (!input.seller?.gstin) throw new Error("Seller GSTIN is required");
  if (!input.items?.length) throw new Error("At least one line item is required");

  const defaultSac = defaults?.sac_code ?? DEFAULT_COWORKING_SAC;
  const defaultRate = defaults?.gst_rate ?? DEFAULT_GST_RATE;

  // ── Buyer classification ──
  const buyerHasGstin = !!input.buyer.gstin && input.buyer.gstin.trim().length === 15;
  const classification: InternalGstInvoice["buyer"]["classification"] = buyerHasGstin
    ? "b2b"
    : "b2c_small"; // default to b2c_small; caller should override to b2c_large for inter-state >₹2.5L

  // ── Place of supply ──
  // For services to a registered recipient: location of the recipient
  // For services to an unregistered recipient: location of the recipient if known, else seller's location
  const buyerStateFromGstin = buyerHasGstin ? stateCodeFromGstin(input.buyer.gstin!) : null;
  const buyerStateCode =
    input.buyer.state_code ||
    buyerStateFromGstin ||
    input.seller.state_code; // fallback for B2C with unknown state

  const intrastate = isIntrastate(input.seller.state_code, buyerStateCode);

  // ── Build line items with full math ──
  const items: InternalGstInvoiceItem[] = input.items.map((it, idx) => {
    const qty = it.quantity ?? 1;
    const unitPrice = it.unit_price;
    const gross = round2(qty * unitPrice);
    const discount = round2(it.discount_amount ?? 0);
    const taxable = round2(gross - discount);
    const rate = it.gst_rate ?? defaultRate;
    const totalTax = round2((taxable * rate) / 100);
    const cgst = intrastate ? round2(totalTax / 2) : 0;
    const sgst = intrastate ? round2(totalTax - cgst) : 0; // ensures cgst + sgst sums to totalTax
    const igst = intrastate ? 0 : totalTax;
    const itemTotal = round2(taxable + cgst + sgst + igst);

    return {
      serial_no: idx + 1,
      is_service: it.is_service ?? true,
      hsn_or_sac_code: it.hsn_or_sac_code ?? defaultSac,
      item_description: it.description,
      unit: it.unit ?? NIC_UNIT_CODES.MONTH,
      quantity: qty,
      unit_price: unitPrice,
      gross_amount: gross,
      discount_amount: discount,
      other_charges: 0,
      taxable_value: taxable,
      gst_rate: rate,
      cgst_amount: cgst,
      sgst_amount: sgst,
      igst_amount: igst,
      cess_rate: 0,
      cess_amount: 0,
      total_item_value: itemTotal,
    };
  });

  // ── Header totals ──
  const totalTaxable = round2(items.reduce((s, i) => s + i.taxable_value, 0));
  const totalCgst = round2(items.reduce((s, i) => s + i.cgst_amount, 0));
  const totalSgst = round2(items.reduce((s, i) => s + i.sgst_amount, 0));
  const totalIgst = round2(items.reduce((s, i) => s + i.igst_amount, 0));
  const totalCess = round2(items.reduce((s, i) => s + i.cess_amount, 0));
  const totalDiscount = round2(items.reduce((s, i) => s + i.discount_amount, 0));

  const sumBeforeRound = round2(totalTaxable + totalCgst + totalSgst + totalIgst + totalCess);
  const wholeRupee = Math.round(sumBeforeRound);
  const roundOff = round2(wholeRupee - sumBeforeRound);
  const totalInvoice = round2(sumBeforeRound + roundOff);

  return {
    doc_type: input.doc_type,
    invoice_number: input.invoice_number,
    invoice_date: input.invoice_date,
    reference_invoice_number: input.reference_invoice_number,
    reference_invoice_date: input.reference_invoice_date,
    seller: input.seller,
    buyer: {
      classification,
      gstin: buyerHasGstin ? input.buyer.gstin!.toUpperCase() : undefined,
      legal_name: input.buyer.legal_name,
      address1: input.buyer.address1 ?? undefined,
      address2: input.buyer.address2 ?? undefined,
      location: input.buyer.city ?? undefined,
      pincode: input.buyer.pincode ?? undefined,
      state_code: buyerStateCode,
      phone: input.buyer.phone ?? undefined,
      email: input.buyer.email ?? undefined,
    },
    place_of_supply_state_code: buyerStateCode,
    is_intrastate: intrastate,
    currency: "INR",
    total_taxable_value: totalTaxable,
    total_cgst_amount: totalCgst,
    total_sgst_amount: totalSgst,
    total_igst_amount: totalIgst,
    total_cess_amount: totalCess,
    total_discount: totalDiscount,
    total_other_charges: 0,
    round_off_amount: roundOff,
    total_invoice_value: totalInvoice,
    items,
    remarks: input.remarks,
  };
}

/**
 * Convenience: build a seller block from the public e-invoice config.
 * Used by API routes that have already loaded EInvoicePublicConfig.
 */
export function sellerFromConfig(config: EInvoicePublicConfig): BuilderSeller {
  return {
    gstin: config.seller_gstin,
    legal_name: config.seller_legal_name,
    trade_name: config.seller_trade_name,
    address1: config.seller_address1,
    address2: config.seller_address2,
    location: config.seller_location,
    pincode: config.seller_pincode,
    state_code: config.seller_state_code,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
