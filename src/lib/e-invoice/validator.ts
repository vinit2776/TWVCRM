/**
 * Pre-flight validation — runs BEFORE we hit the IRP.
 *
 * Why: NIC's IRP rate-limits failures. Catching mistakes locally avoids:
 *   - Wasted API quota
 *   - Token churn
 *   - Audit-log noise
 *   - Frustrated retry loops
 *
 * Returns ValidationResult — not throwing — so the caller can show
 * specific field errors in the UI.
 */

import type { InternalGstInvoice } from "./types";

export interface ValidationIssue {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PINCODE_REGEX = /^[1-9][0-9]{5}$/;
const STATE_CODE_REGEX = /^(0[1-9]|[12][0-9]|3[0-7]|97)$/;  // 01–37 + 97 (other territory)
const ALLOWED_GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 7.5, 12, 18, 28];

/** Validate a single tax invoice for IRN generation. */
export function validateForIrn(inv: InternalGstInvoice): ValidationResult {
  const issues: ValidationIssue[] = [];
  const err = (field: string, message: string) => issues.push({ field, message, severity: "error" });
  const warn = (field: string, message: string) => issues.push({ field, message, severity: "warning" });

  // ─── B2C guard ─────────────────────────────────────────────────────────────
  if (inv.buyer.classification === "b2c_small" || inv.buyer.classification === "b2c_large") {
    err("buyer.classification", "B2C invoices do not require IRN — do not submit to IRP");
    return { ok: false, issues };
  }

  // ─── Document number rules (NIC: max 16 chars, no leading 0/-/​) ─────────
  if (!inv.invoice_number) err("invoice_number", "Invoice number is required");
  else {
    if (inv.invoice_number.length > 16)
      err("invoice_number", "Invoice number cannot exceed 16 characters");
    if (/^[0/-]/.test(inv.invoice_number))
      err("invoice_number", `Invoice number cannot start with "0", "/" or "-" (got "${inv.invoice_number}")`);
    if (!/^[a-zA-Z0-9/-]+$/.test(inv.invoice_number))
      err("invoice_number", "Invoice number can only contain letters, digits, '/' and '-'");
  }

  // ─── Date sanity ───────────────────────────────────────────────────────────
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.invoice_date))
    err("invoice_date", "Invoice date must be ISO YYYY-MM-DD");
  else {
    const d = new Date(inv.invoice_date);
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    if (d > today) err("invoice_date", "Invoice date cannot be in the future");
    // 30-day reporting rule (only for AATO ≥ ₹10 cr — checked at API layer
    // since we don't know the AATO bracket here)
  }

  // ─── Seller GSTIN ──────────────────────────────────────────────────────────
  if (!GSTIN_REGEX.test(inv.seller.gstin))
    err("seller.gstin", `Seller GSTIN "${inv.seller.gstin}" is invalid (expected 15-char format)`);
  if (!STATE_CODE_REGEX.test(inv.seller.state_code))
    err("seller.state_code", `Seller state code "${inv.seller.state_code}" is invalid`);
  if (!PINCODE_REGEX.test(inv.seller.pincode))
    err("seller.pincode", `Seller pincode "${inv.seller.pincode}" must be 6 digits, not starting with 0`);
  if (!inv.seller.legal_name || inv.seller.legal_name.length < 3)
    err("seller.legal_name", "Seller legal name must be at least 3 characters");
  if (inv.seller.legal_name && inv.seller.legal_name.length > 100)
    err("seller.legal_name", "Seller legal name cannot exceed 100 characters");

  // GSTIN state code prefix should match seller state code
  if (
    GSTIN_REGEX.test(inv.seller.gstin) &&
    inv.seller.gstin.slice(0, 2) !== inv.seller.state_code
  ) {
    err(
      "seller.state_code",
      `Seller state code "${inv.seller.state_code}" does not match GSTIN prefix "${inv.seller.gstin.slice(0, 2)}"`
    );
  }

  // ─── Buyer GSTIN (B2B only) ────────────────────────────────────────────────
  if (inv.buyer.classification === "b2b") {
    if (!inv.buyer.gstin)
      err("buyer.gstin", "B2B invoice requires buyer GSTIN");
    else if (!GSTIN_REGEX.test(inv.buyer.gstin))
      err("buyer.gstin", `Buyer GSTIN "${inv.buyer.gstin}" is invalid`);
  }
  if (!inv.buyer.legal_name || inv.buyer.legal_name.length < 3)
    err("buyer.legal_name", "Buyer legal name must be at least 3 characters");

  // ─── Place of supply ───────────────────────────────────────────────────────
  if (!STATE_CODE_REGEX.test(inv.place_of_supply_state_code))
    err("place_of_supply_state_code", "Place of supply state code is invalid");

  // Intrastate flag should match: seller_state == pos
  const expectIntra = inv.seller.state_code === inv.place_of_supply_state_code;
  if (expectIntra !== inv.is_intrastate) {
    err(
      "is_intrastate",
      `is_intrastate=${inv.is_intrastate} contradicts states (seller=${inv.seller.state_code}, pos=${inv.place_of_supply_state_code})`
    );
  }

  // ─── Items ─────────────────────────────────────────────────────────────────
  if (!inv.items || inv.items.length === 0)
    err("items", "Invoice must have at least one line item");
  if (inv.items && inv.items.length > 1000)
    err("items", "Invoice cannot exceed 1000 line items");

  inv.items.forEach((it, idx) => {
    const prefix = `items[${idx}]`;
    if (!it.hsn_or_sac_code) err(`${prefix}.hsn_or_sac_code`, "HSN/SAC code is required");
    else if (!/^\d{4,8}$/.test(it.hsn_or_sac_code))
      err(`${prefix}.hsn_or_sac_code`, `HSN/SAC "${it.hsn_or_sac_code}" must be 4–8 digits`);
    if (!it.item_description) err(`${prefix}.item_description`, "Description is required");
    if (it.item_description && it.item_description.length > 300)
      err(`${prefix}.item_description`, "Description cannot exceed 300 characters");
    if (it.quantity <= 0) err(`${prefix}.quantity`, "Quantity must be > 0");
    if (it.unit_price < 0) err(`${prefix}.unit_price`, "Unit price cannot be negative");
    if (!ALLOWED_GST_RATES.includes(it.gst_rate))
      err(`${prefix}.gst_rate`, `GST rate ${it.gst_rate}% not in [${ALLOWED_GST_RATES.join(", ")}]`);

    // Intrastate consistency
    if (inv.is_intrastate && it.igst_amount > 0)
      err(`${prefix}.igst_amount`, "Intrastate item cannot have IGST > 0");
    if (!inv.is_intrastate && (it.cgst_amount > 0 || it.sgst_amount > 0))
      err(`${prefix}.cgst_amount`, "Interstate item cannot have CGST/SGST");

    // Math sanity (with ₹0.50 tolerance)
    const computedTotal =
      it.taxable_value + it.cgst_amount + it.sgst_amount + it.igst_amount + it.cess_amount + it.other_charges;
    if (Math.abs(computedTotal - it.total_item_value) > 0.5)
      warn(
        `${prefix}.total_item_value`,
        `Computed line total ${computedTotal.toFixed(2)} ≠ stated ${it.total_item_value.toFixed(2)}`
      );
  });

  // ─── Header totals math ────────────────────────────────────────────────────
  const sumTaxable = inv.items.reduce((s, i) => s + i.taxable_value, 0);
  if (Math.abs(sumTaxable - inv.total_taxable_value) > 0.5)
    err("total_taxable_value",
      `Sum of items' taxable values (${sumTaxable.toFixed(2)}) ≠ header total (${inv.total_taxable_value.toFixed(2)})`);

  const computedInvoice =
    inv.total_taxable_value +
    inv.total_cgst_amount +
    inv.total_sgst_amount +
    inv.total_igst_amount +
    inv.total_cess_amount +
    inv.total_other_charges +
    inv.round_off_amount;
  if (Math.abs(computedInvoice - inv.total_invoice_value) > 0.5)
    err("total_invoice_value",
      `Header math: ${computedInvoice.toFixed(2)} ≠ ${inv.total_invoice_value.toFixed(2)}`);

  // ─── Round-off bounds ──────────────────────────────────────────────────────
  if (inv.round_off_amount < -99 || inv.round_off_amount > 99)
    err("round_off_amount", "Round-off must be between -99 and +99");

  return { ok: !issues.some((i) => i.severity === "error"), issues };
}
