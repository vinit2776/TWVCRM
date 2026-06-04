/**
 * HSN/SAC codes for The WorkVilla's invoicing.
 *
 * Section types produced by billing.ts:
 *   "rent" / "prepaid_rent"  → 997221  Rental of space
 *   "booking_usage"          → 997221  Meeting-room hire (still a rental)
 *   "service_usage"          → 998599  Printer, copier & support services
 *   "facility_usage"         → 996912  Electricity (keyword match)
 *                              998712  Maintenance & Repair (default)
 *   "ad_hoc_charges"         → stored hsn_sac_code on usage_charge row,
 *                              falls back to 999799 if not set / still 997212
 *
 * Operator-selectable codes shown in the Add Charge dialog:
 *   996912  Electricity
 *   997221  Rent
 *   998311  Other Professional Technical & Business Services
 *   998599  Service Charges
 *   998712  Maintenance & Repair Service
 *   999799  Other Charges
 *
 * NIC unit codes used in IRN payloads:
 *   MON  → Month (recurring memberships)
 *   NOS  → Number / count (per-seat per-month or daypass)
 *   HUR  → Hour (meeting rooms by hour)
 *   DAY  → Day (daypass)
 *   SET  → Set (bundled package)
 */

export interface SacCodeMeta {
  code: string;
  description: string;
  default_gst_rate: number;
  is_service: true;
}

export const COWORKING_SAC_CODES: Record<string, SacCodeMeta> = {
  "996912": {
    code: "996912",
    description: "Electricity distribution services",
    default_gst_rate: 18,
    is_service: true,
  },
  "997221": {
    code: "997221",
    description: "Rental of office space / coworking space",
    default_gst_rate: 18,
    is_service: true,
  },
  // Kept for backwards-compat — old invoices referenced 997212.
  "997212": {
    code: "997212",
    description: "Rental or leasing services involving own or leased non-residential property",
    default_gst_rate: 18,
    is_service: true,
  },
  "998311": {
    code: "998311",
    description: "Other professional, technical and business services",
    default_gst_rate: 18,
    is_service: true,
  },
  "998599": {
    code: "998599",
    description: "Service charges — printing, copier and support services",
    default_gst_rate: 18,
    is_service: true,
  },
  "998712": {
    code: "998712",
    description: "Maintenance and repair services of other machinery and equipment",
    default_gst_rate: 18,
    is_service: true,
  },
  "999799": {
    code: "999799",
    description: "Other miscellaneous services",
    default_gst_rate: 18,
    is_service: true,
  },
};

/** Default SAC for new co-working revenue lines. */
export const DEFAULT_COWORKING_SAC = "997221";
export const DEFAULT_GST_RATE = 18;

/**
 * Operator-selectable HSN/SAC options shown in the Add Charge dialog
 * and anywhere a line-item type needs to be chosen.
 */
export const HSN_SAC_OPTIONS: { code: string; label: string }[] = [
  { code: "997221", label: "Rent" },
  { code: "996912", label: "Electricity" },
  { code: "998311", label: "Other Professional Technical & Business Services" },
  { code: "998599", label: "Service Charges" },
  { code: "998712", label: "Maintenance & Repair Service" },
  { code: "999799", label: "Other Charges" },
];

/**
 * Resolves the correct HSN/SAC code for a billing-statement line item.
 *
 * Priority:
 *  1. `storedCode` — the code recorded on the usage_charge row (if set and
 *     not the legacy default "997212").
 *  2. `sectionType` — the structured section type from billing.ts.
 *  3. Falls back to 999799.
 *
 * For facility_usage a keyword check on the description/label is done so
 * electricity lines get 996912 instead of the generic 998712.
 */
export function resolveHsnCode(
  sectionType: string | null | undefined,
  storedCode?: string | null,
  labelHint?: string | null,
): string {
  // If operator explicitly chose a code (other than the old default), honour it.
  if (storedCode && storedCode !== "997212") return storedCode;

  switch (sectionType) {
    case "rent":
    case "prepaid_rent":
    case "booking_usage":
      return "997221";

    case "service_usage":
      return "998599";

    case "facility_usage": {
      // Electricity lines carry keywords in the facility name / label.
      const hint = (labelHint || "").toLowerCase();
      if (/electric|power|eb |eb\b|kwh|units/i.test(hint)) return "996912";
      return "998712";
    }

    case "ad_hoc_charges":
    default:
      return storedCode || "999799";
  }
}

/** NIC's 3-character unit codes — limited to the ones we actually use. */
export const NIC_UNIT_CODES = {
  MONTH: "MON",
  NUMBER: "NOS",
  HOUR: "HUR",
  DAY: "DAY",
  SET: "SET",
  PIECE: "PCS",
} as const;

export type NicUnitCode = (typeof NIC_UNIT_CODES)[keyof typeof NIC_UNIT_CODES];
