// How valuable an enquiry looks, and why. Value is an ESTIMATE: seats x price per seat per month,
// where the price is what we quoted, else what they said they can spend, else our standard rate
// for that seat type and location (marked "est."). The tier always comes with its reasons so
// nobody has to trust a hidden score.

export type ValueTier = "high" | "worth_a_call" | "passing";

export const VALUE_TIER_LABELS: Record<ValueTier, string> = {
  high: "High value",
  worth_a_call: "Worth a call",
  passing: "Passing",
};

/** Placeholder thresholds from the design; change them here and everything follows. */
export const HIGH_VALUE_MONTHLY = 50_000;
export const WORTH_A_CALL_MONTHLY = 15_000;
export const HIGH_VALUE_SEATS = 10;
export const SOON_START_DAYS = 56;

const OFFICE_TYPES = ["private_office", "managed", "enterprise"];
const SMALL_TYPES = ["virtual_office", "hot_desk"];

export interface ValueInput {
  seats?: number | null;
  workspaceType?: string | null;
  /** What we quoted per seat per month. */
  quotedPerSeat?: number | null;
  /** What they said they can spend per seat per month. */
  budgetPerSeat?: number | null;
  /** Our standard monthly price per seat for this type and location, if the rate card has one. */
  standardRate?: number | null;
  hasCompany?: boolean;
  /** yyyy-MM-dd, when they want to start. */
  startDate?: string | null;
  now?: Date;
}

export interface ValueResult {
  /** Estimated rupees per month, or null when seats or any price are unknown. */
  monthly: number | null;
  /** True when the price came from the rate card rather than from the customer or a quote. */
  estimated: boolean;
  tier: ValueTier;
  reasons: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startsSoon(startDate: string | null | undefined, now: Date): boolean {
  if (!startDate) return false;
  const t = Date.parse(`${startDate}T00:00:00+05:30`);
  if (Number.isNaN(t)) return false;
  const days = (t - now.getTime()) / DAY_MS;
  return days <= SOON_START_DAYS;
}

export function assessValue(i: ValueInput): ValueResult {
  const now = i.now ?? new Date();
  const seats = i.seats && i.seats > 0 ? i.seats : null;
  const given = i.quotedPerSeat || i.budgetPerSeat || null;
  const price = given ?? (i.standardRate && i.standardRate > 0 ? i.standardRate : null);
  const estimated = !given && price !== null;
  const monthly = seats && price ? Math.round(seats * price) : null;
  const type = i.workspaceType ?? "";

  const reasons: string[] = [];
  if (i.hasCompany) reasons.push("company given");
  const soon = startsSoon(i.startDate, now);
  if (soon) reasons.push("starts within 8 weeks");

  // High value: any one of these is enough.
  if (monthly !== null && monthly >= HIGH_VALUE_MONTHLY) {
    return { monthly, estimated, tier: "high", reasons: [`about ₹${monthly.toLocaleString("en-IN")} a month`, ...reasons] };
  }
  if (seats !== null && seats >= HIGH_VALUE_SEATS) {
    return { monthly, estimated, tier: "high", reasons: [`${seats} seats`, ...reasons] };
  }
  if (OFFICE_TYPES.includes(type) && i.hasCompany && soon) {
    return { monthly, estimated, tier: "high", reasons: ["office with a company", "starts within 8 weeks"] };
  }

  // Passing: small and quick, or too little to be worth a call.
  if (seats !== null && seats <= 2 && SMALL_TYPES.includes(type)) {
    return { monthly, estimated, tier: "passing", reasons: [`${seats} seat${seats === 1 ? "" : "s"} of ${type.replace(/_/g, " ")}`, ...reasons] };
  }
  if (monthly === null) {
    return { monthly, estimated, tier: "passing", reasons: [seats === null ? "no seats given" : "no price or budget given", ...reasons] };
  }
  if (monthly < WORTH_A_CALL_MONTHLY) {
    return { monthly, estimated, tier: "passing", reasons: [`about ₹${monthly.toLocaleString("en-IN")} a month`, ...reasons] };
  }

  return { monthly, estimated, tier: "worth_a_call", reasons: [`about ₹${monthly.toLocaleString("en-IN")} a month`, ...reasons] };
}

/** ₹96,000 -> "₹96,000"; ₹3,10,000 -> "₹3.1 L"; ₹1,42,00,000 -> "₹1.4 Cr". */
export function formatValue(rupees: number): string {
  if (rupees >= 1_00_00_000) return `₹${(rupees / 1_00_00_000).toFixed(1)} Cr`;
  if (rupees >= 1_00_000) return `₹${(rupees / 1_00_000).toFixed(1)} L`;
  return `₹${rupees.toLocaleString("en-IN")}`;
}

/** Fixed themes for the free text people write. Matched on whole words, case-insensitively. */
export const REQUEST_THEMES: { key: string; label: string; words: string[] }[] = [
  { key: "tour", label: "Tour / visit", words: ["tour", "visit", "site visit", "see the space", "walk-in", "walkin"] },
  { key: "parking", label: "Parking", words: ["parking", "park"] },
  { key: "meeting", label: "Meeting room hours", words: ["meeting room", "conference", "boardroom"] },
  { key: "access", label: "24×7 access", words: ["24x7", "24/7", "24 x 7", "round the clock", "night access"] },
  { key: "gst", label: "GST invoice", words: ["gst"] },
  { key: "soon", label: "Wants to start soon", words: ["immediately", "asap", "urgent", "this week", "next week", "tomorrow"] },
];

/** The themes a piece of free text touches. */
export function requestThemes(text: string | null | undefined): string[] {
  if (!text) return [];
  const t = text.toLowerCase();
  const out: string[] = [];
  for (const th of REQUEST_THEMES) {
    if (th.words.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i").test(t))) out.push(th.key);
  }
  return out;
}

export const SEAT_BANDS = [
  { key: "1-2", label: "1 – 2 seats", min: 1, max: 2 },
  { key: "3-5", label: "3 – 5 seats", min: 3, max: 5 },
  { key: "6-9", label: "6 – 9 seats", min: 6, max: 9 },
  { key: "10+", label: "10+ seats", min: 10, max: Infinity },
] as const;

export function seatBand(seats: number | null | undefined): string | null {
  if (!seats || seats < 1) return null;
  return SEAT_BANDS.find((b) => seats >= b.min && seats <= b.max)?.key ?? null;
}
