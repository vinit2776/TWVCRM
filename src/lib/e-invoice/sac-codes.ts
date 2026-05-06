/**
 * SAC code defaults for co-working / shared workspace operations.
 *
 * Confirmed via search of CBIC SAC master:
 *   997212 — "Rental or leasing services involving own or leased
 *            non-residential property" — 18% GST
 *
 * Adjacent codes you may need for line items:
 *   998599 — Other support services n.e.c. (admin support, mail handling)
 *   998314 — IT consulting services
 *   998596 — Events, conferences, exhibitions
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
  "997212": {
    code: "997212",
    description: "Rental or leasing services involving own or leased non-residential property",
    default_gst_rate: 18,
    is_service: true,
  },
  "998599": {
    code: "998599",
    description: "Other support services n.e.c.",
    default_gst_rate: 18,
    is_service: true,
  },
  "998314": {
    code: "998314",
    description: "Information technology (IT) consulting services",
    default_gst_rate: 18,
    is_service: true,
  },
  "998596": {
    code: "998596",
    description: "Events, exhibitions, conventions and trade shows organisation services",
    default_gst_rate: 18,
    is_service: true,
  },
};

/** Default SAC for co-working revenue. */
export const DEFAULT_COWORKING_SAC = "997212";
export const DEFAULT_GST_RATE = 18;

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
