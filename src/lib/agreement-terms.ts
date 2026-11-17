import { z } from "zod";

/**
 * What the membership agreement's Schedule (rows 4, 6 and 7) says about a
 * location's facilities. Each line is printed word for word as one bullet —
 * the app never composes a sentence around a rate.
 *
 * A location with no saved terms (`agreement_terms` null) prints the standard
 * wording, byte for byte as before this existed. Terms only take over once
 * someone saves them for that location.
 */

export interface FacilityTerms {
  /** Schedule row 4 — included in the membership. */
  inclusions: string[];
  /** Schedule row 6 — paid beyond the complimentary allowance. */
  paid: string[];
  /** Schedule row 7 — rack rate. */
  rates: string[];
}

export interface AgreementTerms {
  /** Always printed, whatever facilities are ticked. */
  general: FacilityTerms;
  /** Keyed by amenity key (`proposal_amenity_icons`); only ticked ones print. */
  facilities: Record<string, FacilityTerms>;
}

/** Same keys as `proposal_amenity_icons` and the Services tab's amenity grid. */
export const AGREEMENT_FACILITIES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "wifi", label: "Hi-speed Internet" },
  { key: "coffee", label: "Pantry Services" },
  { key: "printer", label: "Printing Facilities" },
  { key: "meeting", label: "Conference & Meeting Rooms" },
  { key: "power_backup", label: "Power Backup" },
  { key: "parking", label: "Parking Available" },
  { key: "cctv", label: "CCTV & Security" },
  { key: "reception", label: "Reception / Front Desk" },
];

/** Amenities a location shows when none have been chosen (matches the proposal PDF). */
export const DEFAULT_AMENITY_KEYS = ["wifi", "coffee", "printer", "meeting"];

/** Who may set a location's agreement wording. Sales reps write the contracts, so they set it; every other location setting stays admin/manager. */
export const AGREEMENT_TERMS_EDITOR_ROLES = ["admin", "manager", "sales_rep"] as const;
export const canEditAgreementTerms = (role: string | null | undefined): boolean =>
  (AGREEMENT_TERMS_EDITOR_ROLES as readonly string[]).includes(role ?? "");

export const MAX_TERM_LINES = 12;
export const MAX_TERM_LINE_LENGTH = 300;

const empty = (): FacilityTerms => ({ inclusions: [], paid: [], rates: [] });

/** The standard wording, split by facility. Seeds the editor; "Reset" restores it. */
export const STANDARD_GENERAL_TERMS: FacilityTerms = {
  inclusions: [
    "Electricity & air conditioning consumed during office hours.",
    "Housekeeping, security and maintenance services",
  ],
  paid: [
    "Other value-added member services as available.",
    "Additional charges of Rs.2500/- per hour will be implemented after office hours and on Public Holidays.",
  ],
  rates: [],
};

export const STANDARD_FACILITY_TERMS: Record<string, FacilityTerms> = {
  wifi: { ...empty(), inclusions: ["Wi-Fi and Internet as per fair usage Policy"] },
  coffee: {
    inclusions: ["Hot tea & coffee from specified vending machine 12 cups per week, per seat."],
    paid: ["Other Food & Beverages sales counters including Cafe / Vending Machine and others."],
    rates: ["Coffee/Tea twice a day compliment, additional cups @ Rs.20/-"],
  },
  printer: {
    ...empty(),
    paid: ["Printouts beyond Complimentary Services"],
    rates: ["Additional printouts - A4 - Color Rs.20 per sheet / B&W Rs. 5 per sheet. A3 - Color Rs.25 per sheet."],
  },
  meeting: {
    ...empty(),
    paid: ["Conference Room beyond Complimentary Services (if any)"],
    rates: ["Conference Room @ INR 1000 per hour plus GST"],
  },
  parking: { ...empty(), rates: ["Additional Car & Bike parking slots - subject to availability."] },
};

/** Standard terms for every facility, as an editable starting point. */
export function standardAgreementTerms(): AgreementTerms {
  const clone = (t: FacilityTerms): FacilityTerms => ({
    inclusions: [...t.inclusions], paid: [...t.paid], rates: [...t.rates],
  });
  return {
    general: clone(STANDARD_GENERAL_TERMS),
    facilities: Object.fromEntries(
      AGREEMENT_FACILITIES.map(({ key }) => [key, clone(STANDARD_FACILITY_TERMS[key] ?? empty())])
    ),
  };
}

const linesSchema = z.array(z.string().max(MAX_TERM_LINE_LENGTH)).max(MAX_TERM_LINES);
const facilityTermsSchema = z.object({ inclusions: linesSchema, paid: linesSchema, rates: linesSchema });
const FACILITY_KEYS = AGREEMENT_FACILITIES.map((f) => f.key);

export const agreementTermsSchema = z.object({
  general: facilityTermsSchema,
  facilities: z.record(z.string(), facilityTermsSchema).refine(
    (f) => Object.keys(f).every((k) => FACILITY_KEYS.includes(k)),
    { message: "Unknown facility" }
  ),
});

const cleanLines = (lines: string[]) => lines.map((l) => l.trim()).filter(Boolean);
const cleanTerms = (t: FacilityTerms): FacilityTerms => ({
  inclusions: cleanLines(t.inclusions), paid: cleanLines(t.paid), rates: cleanLines(t.rates),
});

/** Trim and drop blank lines. Call after `agreementTermsSchema` has accepted the input. */
export function cleanAgreementTerms(terms: AgreementTerms): AgreementTerms {
  return {
    general: cleanTerms(terms.general),
    facilities: Object.fromEntries(Object.entries(terms.facilities).map(([k, v]) => [k, cleanTerms(v)])),
  };
}

/** Defensive read of a stored value — anything malformed means "use the standard wording". */
export function readAgreementTerms(raw: unknown): AgreementTerms | null {
  const parsed = agreementTermsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface ScheduleLines {
  inclusions: string[];
  paid: string[];
  rates: string[];
}

/** The wording every location printed before per-location terms existed. */
const LEGACY_LINES: ScheduleLines = {
  inclusions: [
    "Electricity & air conditioning consumed during office hours.",
    "Wi-Fi and Internet as per fair usage Policy",
    "Housekeeping, security and maintenance services",
    "Hot tea & coffee from specified vending machine 12 cups per week, per seat.",
  ],
  paid: [
    "Conference Room beyond Complimentary Services (if any)",
    "Printouts beyond Complimentary Services",
    "Other Food & Beverages sales counters including Cafe / Vending Machine and others.",
    "Other value-added member services as available.",
    "Additional charges of Rs.2500/- per hour will be implemented after office hours and on Public Holidays.",
  ],
  rates: [
    "Conference Room @ INR 1000 per hour plus GST",
    "Additional printouts - A4 - Color Rs.20 per sheet / B&W Rs. 5 per sheet. A3 - Color Rs.25 per sheet.",
    "Coffee/Tea twice a day compliment, additional cups @ Rs.20/-",
    "Additional Car & Bike parking slots - subject to availability.",
  ],
};

/**
 * Lines for Schedule rows 4, 6 and 7. General inclusions come first, then each
 * ticked facility in catalogue order, then general paid/rate lines last.
 */
export function buildScheduleLines(
  terms: AgreementTerms | null | undefined,
  amenityKeys: string[] | null | undefined
): ScheduleLines {
  if (!terms) {
    return { inclusions: [...LEGACY_LINES.inclusions], paid: [...LEGACY_LINES.paid], rates: [...LEGACY_LINES.rates] };
  }
  const ticked = new Set(amenityKeys ?? DEFAULT_AMENITY_KEYS);
  const facilities = AGREEMENT_FACILITIES
    .filter(({ key }) => ticked.has(key))
    .map(({ key }) => terms.facilities[key])
    .filter((t): t is FacilityTerms => Boolean(t));
  return {
    inclusions: [...terms.general.inclusions, ...facilities.flatMap((t) => t.inclusions)],
    paid: [...facilities.flatMap((t) => t.paid), ...terms.general.paid],
    rates: [...facilities.flatMap((t) => t.rates), ...terms.general.rates],
  };
}

/** One bullet per line, as printed in the Schedule. */
export function formatScheduleRow(lines: string[]): string {
  return lines.length === 0 ? "Nil" : lines.map((l) => `• ${l}`).join("\n");
}
