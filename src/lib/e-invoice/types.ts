/**
 * NIC e-Invoice schema types — v1.1 (current spec as of May 2026)
 *
 * Source: https://einv-apisandbox.nic.in/version1.03/generate-irn.html
 *
 * These types model the JSON payload sent to the IRP. Field names match
 * NIC's spec exactly (PascalCase, abbreviated) — DO NOT renamed without
 * updating the schema-mapper too.
 */

// ─── Top-level payload ───────────────────────────────────────────────────────

export interface NicEInvoicePayload {
  Version: "1.1";
  TranDtls: TranDtls;
  DocDtls: DocDtls;
  SellerDtls: SellerDtls;
  BuyerDtls: BuyerDtls;
  DispDtls?: DispDtls;
  ShipDtls?: ShipDtls;
  ItemList: ItemDtls[];
  ValDtls: ValDtls;
  PayDtls?: PayDtls;
  RefDtls?: RefDtls;
  AddlDocDtls?: AddlDocDtls[];
  ExpDtls?: ExpDtls;
  EwbDtls?: EwbDtls;
}

// ─── Transaction details ─────────────────────────────────────────────────────

export interface TranDtls {
  TaxSch: "GST";
  SupTyp: SupplyType;            // B2B, B2C-disallowed, EXPWP, EXPWOP, SEZWP, SEZWOP, DEXP
  RegRev?: "Y" | "N";            // Reverse charge applicability (default N)
  EcmGstin?: string;             // E-commerce operator GSTIN (for TCS)
  IgstOnIntra?: "Y" | "N";       // IGST on intrastate (rare, default N)
}

export type SupplyType =
  | "B2B"      // Business to Business (most co-working invoices)
  | "EXPWP"    // Export with payment of GST
  | "EXPWOP"   // Export without payment (LUT)
  | "SEZWP"    // SEZ supply with payment
  | "SEZWOP"   // SEZ supply without payment
  | "DEXP";    // Deemed Export

// ─── Document details ────────────────────────────────────────────────────────

export interface DocDtls {
  Typ: "INV" | "CRN" | "DBN";    // Invoice / Credit Note / Debit Note
  No: string;                     // Invoice number — max 16 chars, no leading 0/-/​
  Dt: string;                     // DD/MM/YYYY
}

// ─── Seller / Buyer details ──────────────────────────────────────────────────

export interface SellerDtls {
  Gstin: string;                  // 15-char GSTIN
  LglNm: string;                  // Legal name (3-100 chars)
  TrdNm?: string;                 // Trade name
  Addr1: string;                  // 1-100 chars
  Addr2?: string;                 // 1-100 chars
  Loc: string;                    // 3-50 chars
  Pin: number;                    // 6-digit pincode
  Stcd: string;                   // 2-digit state code, e.g. "33"
  Ph?: string;                    // 6-12 chars
  Em?: string;                    // 6-100 chars (email)
}

export interface BuyerDtls {
  Gstin: string;                  // "URP" if unregistered (B2C)
  LglNm: string;
  TrdNm?: string;
  Pos: string;                    // Place of supply state code (2 digits)
  Addr1: string;
  Addr2?: string;
  Loc: string;
  Pin: number;
  Stcd: string;
  Ph?: string;
  Em?: string;
}

export interface DispDtls {
  Nm: string;
  Addr1: string;
  Addr2?: string;
  Loc: string;
  Pin: number;
  Stcd: string;
}

export interface ShipDtls {
  Gstin?: string;
  LglNm: string;
  TrdNm?: string;
  Addr1: string;
  Addr2?: string;
  Loc: string;
  Pin: number;
  Stcd: string;
}

// ─── Item list ───────────────────────────────────────────────────────────────

export interface ItemDtls {
  SlNo: string;                   // "1", "2", ... — string per NIC spec
  PrdDesc?: string;               // Product / service description (3-300 chars)
  IsServc: "Y" | "N";             // Y for services
  HsnCd: string;                  // 4/6/8 digit HSN or SAC code
  Barcde?: string;
  Qty?: number;                   // Up to 3 decimal places
  FreeQty?: number;
  Unit?: string;                  // 3-char NIC unit code (e.g. "MON", "NOS")
  UnitPrice: number;              // Up to 3 decimal places
  TotAmt: number;                 // Qty × UnitPrice (gross)
  Discount?: number;
  PreTaxVal?: number;
  AssAmt: number;                 // Taxable value (after discount)
  GstRt: number;                  // 0 / 0.1 / 0.25 / 1 / 1.5 / 3 / 5 / 7.5 / 12 / 18 / 28
  IgstAmt?: number;
  CgstAmt?: number;
  SgstAmt?: number;
  CesRt?: number;
  CesAmt?: number;
  CesNonAdvlAmt?: number;
  StateCesRt?: number;
  StateCesAmt?: number;
  StateCesNonAdvlAmt?: number;
  OthChrg?: number;
  TotItemVal: number;             // AssAmt + all GST + cess + other charges
  OrdLineRef?: string;
  OrgCntry?: string;
  PrdSlNo?: string;
  BchDtls?: { Nm: string; ExpDt?: string; WrDt?: string };
  AttribDtls?: Array<{ Nm: string; Val: string }>;
}

// ─── Value totals ────────────────────────────────────────────────────────────

export interface ValDtls {
  AssVal: number;                 // Sum of AssAmt across items
  CgstVal?: number;
  SgstVal?: number;
  IgstVal?: number;
  CesVal?: number;
  StCesVal?: number;
  Discount?: number;
  OthChrg?: number;
  RndOffAmt?: number;             // -99 to +99
  TotInvVal: number;              // Final invoice value (in INR)
  TotInvValFc?: number;           // In foreign currency, if applicable
}

// ─── Optional sections ───────────────────────────────────────────────────────

export interface PayDtls {
  Nm?: string;
  AccDet?: string;
  Mode?: string;
  FinInsBr?: string;
  PayTerm?: string;
  PayInstr?: string;
  CrTrn?: string;
  DirDr?: string;
  CrDay?: number;
  PaidAmt?: number;
  PaymtDue?: number;
}

export interface RefDtls {
  InvRm?: string;                 // Remarks
  DocPerdDtls?: { InvStDt: string; InvEndDt: string };
  PrecDocDtls?: Array<{ InvNo: string; InvDt: string; OthRefNo?: string }>;
  ContrDtls?: Array<{
    RecAdvRefr?: string;
    RecAdvDt?: string;
    TendRefr?: string;
    ContrRefr?: string;
    ExtRefr?: string;
    ProjRefr?: string;
    PORefr?: string;
    PORefDt?: string;
  }>;
}

export interface AddlDocDtls {
  Url?: string;
  Docs?: string;
  Info?: string;
}

export interface ExpDtls {
  ShipBNo?: string;
  ShipBDt?: string;
  Port?: string;
  RefClm?: "Y" | "N";
  ForCur?: string;
  CntCode?: string;
  ExpDuty?: number;
}

export interface EwbDtls {
  TransId?: string;
  TransName?: string;
  Distance?: number;
  TransDocNo?: string;
  TransDocDt?: string;
  VehNo?: string;
  VehType?: "R" | "O";
  TransMode?: "1" | "2" | "3" | "4";  // 1=Road 2=Rail 3=Air 4=Ship
}

// ─── Response types ──────────────────────────────────────────────────────────

export interface NicGenerateIrnSuccess {
  AckNo: number | string;
  AckDt: string;                  // "yyyy-MM-dd HH:mm:ss"
  Irn: string;                    // 64-char SHA256 hash
  SignedInvoice: string;          // JWT
  SignedQRCode: string;           // JWT
  Status: "ACT" | "CNL";
  EwbNo?: string;
  EwbDt?: string;
  EwbValidTill?: string;
  Remarks?: string;
}

export interface NicCancelIrnRequest {
  Irn: string;                    // 64 chars exactly
  CnlRsn: "1" | "2" | "3" | "4";
  CnlRem?: string;                // 0-100 chars
}

export interface NicCancelIrnSuccess {
  Irn: string;
  CancelDate: string;             // "yyyy-MM-dd HH:mm:ss"
}

export interface NicErrorDetail {
  ErrorCode: string;
  ErrorMessage: string;
}

// ─── Internal "intent" type — what our app passes to the schema mapper ───────

/**
 * The shape our application uses to describe a tax invoice before it is
 * shaped into NIC's NicEInvoicePayload. The schema-mapper consumes this.
 *
 * This shape mirrors the gst_invoices + gst_invoice_items DB rows but is
 * decoupled from any specific DB structure for testability.
 */
export interface InternalGstInvoice {
  // Identity
  doc_type: "INV" | "CRN" | "DBN";
  invoice_number: string;
  invoice_date: string;           // ISO YYYY-MM-DD

  // Reference (for CRN/DBN)
  reference_invoice_number?: string;
  reference_invoice_date?: string;

  // Seller (denormalised)
  seller: {
    gstin: string;
    legal_name: string;
    trade_name?: string;
    address1: string;
    address2?: string;
    location: string;
    pincode: string;               // string to preserve leading zero
    state_code: string;
    phone?: string;
    email?: string;
  };

  // Buyer
  buyer: {
    classification: "b2b" | "b2c_small" | "b2c_large" | "export" | "sez_with_payment" | "sez_without_payment" | "deemed_export";
    gstin?: string;                // undefined for B2C
    legal_name: string;
    trade_name?: string;
    address1?: string;
    address2?: string;
    location?: string;
    pincode?: string;
    state_code?: string;
    phone?: string;
    email?: string;
  };

  // Place of supply
  place_of_supply_state_code: string;
  is_intrastate: boolean;

  // Money
  currency: "INR";
  total_taxable_value: number;
  total_cgst_amount: number;
  total_sgst_amount: number;
  total_igst_amount: number;
  total_cess_amount: number;
  total_discount: number;
  total_other_charges: number;
  round_off_amount: number;
  total_invoice_value: number;

  // Items
  items: InternalGstInvoiceItem[];

  // Optional
  remarks?: string;
}

export interface InternalGstInvoiceItem {
  serial_no: number;
  is_service: boolean;
  hsn_or_sac_code: string;
  item_description: string;
  unit?: string;                   // 3-char NIC unit code
  quantity: number;
  unit_price: number;
  gross_amount: number;
  discount_amount: number;
  other_charges: number;
  taxable_value: number;
  gst_rate: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  cess_rate: number;
  cess_amount: number;
  total_item_value: number;
}
