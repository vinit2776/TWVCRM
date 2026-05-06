/**
 * Maps the application's InternalGstInvoice shape to NIC's NicEInvoicePayload
 * (schema v1.1). Pure function — no I/O, fully unit-testable.
 *
 * Rules implemented:
 * - Date format: YYYY-MM-DD (DB) → DD/MM/YYYY (NIC)
 * - URP for unregistered buyers (B2C)
 * - SupplyType derivation from buyer classification
 * - Intrastate → CGST+SGST; interstate → IGST (zero out the unused side)
 * - Pincode coerced to integer (NIC expects number); state code stays string
 * - Round to 2 decimals on every monetary field
 */

import type {
  InternalGstInvoice,
  NicEInvoicePayload,
  SupplyType,
  ItemDtls,
  ValDtls,
  BuyerDtls,
  SellerDtls,
} from "./types";

/** Convert ISO YYYY-MM-DD → DD/MM/YYYY (NIC's required format) */
export function formatNicDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  if (!y || !m || !d) throw new Error(`formatNicDate: invalid ISO date "${isoDate}"`);
  return `${d}/${m}/${y}`;
}

/** Round to 2 decimal places (NIC monetary precision) */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Map app classification → NIC SupplyType */
function deriveSupplyType(c: InternalGstInvoice["buyer"]["classification"]): SupplyType {
  switch (c) {
    case "b2b":                  return "B2B";
    case "export":               return "EXPWP";   // default with-payment; caller can override
    case "sez_with_payment":     return "SEZWP";
    case "sez_without_payment":  return "SEZWOP";
    case "deemed_export":        return "DEXP";
    case "b2c_small":
    case "b2c_large":
      throw new Error(
        "B2C invoices do NOT require IRN — schema-mapper should not be called for B2C. " +
        "Filter B2C upstream in the e-invoice trigger logic."
      );
  }
}

/** Build the SellerDtls block */
function mapSeller(inv: InternalGstInvoice): SellerDtls {
  const s = inv.seller;
  return {
    Gstin: s.gstin,
    LglNm: s.legal_name,
    TrdNm: s.trade_name,
    Addr1: s.address1,
    Addr2: s.address2,
    Loc: s.location,
    Pin: parseInt(s.pincode, 10),
    Stcd: s.state_code,
    Ph: s.phone,
    Em: s.email,
  };
}

/** Build the BuyerDtls block. URP for unregistered buyers. */
function mapBuyer(inv: InternalGstInvoice): BuyerDtls {
  const b = inv.buyer;
  return {
    Gstin: b.gstin ?? "URP",
    LglNm: b.legal_name,
    TrdNm: b.trade_name,
    Pos: inv.place_of_supply_state_code,
    Addr1: b.address1 ?? "Not Provided",
    Addr2: b.address2,
    Loc: b.location ?? "Not Provided",
    Pin: b.pincode ? parseInt(b.pincode, 10) : 999999,  // 999999 = "unknown" placeholder per NIC convention
    Stcd: b.state_code ?? inv.place_of_supply_state_code,
    Ph: b.phone,
    Em: b.email,
  };
}

/** Build the ItemList — clears CGST/SGST or IGST based on intra/inter-state */
function mapItems(inv: InternalGstInvoice): ItemDtls[] {
  return inv.items.map((it) => {
    // Defensive: zero out the unused tax type
    const cgst = inv.is_intrastate ? r2(it.cgst_amount) : 0;
    const sgst = inv.is_intrastate ? r2(it.sgst_amount) : 0;
    const igst = inv.is_intrastate ? 0 : r2(it.igst_amount);

    return {
      SlNo: String(it.serial_no),
      PrdDesc: it.item_description.slice(0, 300),
      IsServc: it.is_service ? "Y" : "N",
      HsnCd: it.hsn_or_sac_code,
      Qty: it.quantity,
      Unit: it.unit,
      UnitPrice: r2(it.unit_price),
      TotAmt: r2(it.gross_amount),
      Discount: it.discount_amount > 0 ? r2(it.discount_amount) : undefined,
      AssAmt: r2(it.taxable_value),
      GstRt: r2(it.gst_rate),
      CgstAmt: cgst,
      SgstAmt: sgst,
      IgstAmt: igst,
      CesRt: it.cess_rate > 0 ? r2(it.cess_rate) : undefined,
      CesAmt: it.cess_amount > 0 ? r2(it.cess_amount) : undefined,
      OthChrg: it.other_charges > 0 ? r2(it.other_charges) : undefined,
      TotItemVal: r2(it.total_item_value),
    };
  });
}

/** Build the ValDtls block (header totals). */
function mapValues(inv: InternalGstInvoice): ValDtls {
  return {
    AssVal: r2(inv.total_taxable_value),
    CgstVal: inv.is_intrastate ? r2(inv.total_cgst_amount) : 0,
    SgstVal: inv.is_intrastate ? r2(inv.total_sgst_amount) : 0,
    IgstVal: inv.is_intrastate ? 0 : r2(inv.total_igst_amount),
    CesVal: inv.total_cess_amount > 0 ? r2(inv.total_cess_amount) : undefined,
    Discount: inv.total_discount > 0 ? r2(inv.total_discount) : undefined,
    OthChrg: inv.total_other_charges > 0 ? r2(inv.total_other_charges) : undefined,
    RndOffAmt: inv.round_off_amount !== 0 ? r2(inv.round_off_amount) : undefined,
    TotInvVal: r2(inv.total_invoice_value),
  };
}

/**
 * Top-level entry point.
 *
 * Throws if called for B2C invoices (which don't need IRN).
 */
export function mapInternalToNic(inv: InternalGstInvoice): NicEInvoicePayload {
  const supplyType = deriveSupplyType(inv.buyer.classification);

  return {
    Version: "1.1",
    TranDtls: {
      TaxSch: "GST",
      SupTyp: supplyType,
      RegRev: "N",
      IgstOnIntra: "N",
    },
    DocDtls: {
      Typ: inv.doc_type,
      No: inv.invoice_number,
      Dt: formatNicDate(inv.invoice_date),
    },
    SellerDtls: mapSeller(inv),
    BuyerDtls: mapBuyer(inv),
    ItemList: mapItems(inv),
    ValDtls: mapValues(inv),
    RefDtls: inv.remarks ? { InvRm: inv.remarks.slice(0, 100) } : undefined,
  };
}
