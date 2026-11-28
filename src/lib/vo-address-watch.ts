/**
 * Post-lapse address watch and holdover billing: the pure rules.
 *
 * When a Virtual Office case lapses we check public records for our address,
 * keep each check as evidence, and while the address is still in use bill a
 * monthly proforma at an escalated rate until deregistration proof is verified
 * or public records are clear on two checks. Everything here is a pure
 * function so the rules are unit testable; the job that runs the checks and
 * raises invoices only executes these decisions.
 */

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

/**
 * off      the watch does nothing. The default, so shipping the code reaches no one.
 * dry_run  reports what it would do; changes nothing and contacts no one.
 * live     acts.
 */
export const VO_ADDRESS_WATCH_MODE_SETTING = "vo_address_watch_mode";
export const WATCH_MODES = ["off", "dry_run", "live"] as const;
export type WatchMode = (typeof WATCH_MODES)[number];

/**
 * A missing setting is off. A value that is present but unrecognised is a dry
 * run, never live (the same fallback as parseCronMode in vo-renewal-reminders).
 */
export function parseWatchMode(value: string | null | undefined): WatchMode {
  if (value === null || value === undefined || value === "") return "off";
  return (WATCH_MODES as readonly string[]).includes(value) ? (value as WatchMode) : "dry_run";
}

// ---------------------------------------------------------------------------
// Address matching
// ---------------------------------------------------------------------------

const ABBREVIATIONS: Record<string, string> = {
  rd: "road",
  st: "street",
  str: "street",
  flr: "floor",
  fl: "floor",
  bldg: "building",
  bld: "building",
  blk: "block",
  nr: "near",
  opp: "opposite",
  ste: "suite",
  sec: "sector",
  ave: "avenue",
  apt: "apartment",
  ngr: "nagar",
  nagr: "nagar",
  ext: "extension",
  indl: "industrial",
  ind: "industrial",
  est: "estate",
  blr: "bangalore",
  bengaluru: "bangalore",
  bangalore: "bangalore",
};

/** Words that carry no location signal. */
const STOPWORDS = new Set([
  "no", "number", "the", "and", "of", "near", "opposite", "floor", "building", "block",
  "suite", "india", "karnataka", "ka", "state", "city", "main", "cross",
]);

const PINCODE = /\b[1-9]\d{5}\b/;
const ORDINAL = /^\d+(st|nd|rd|th)$/;

/** Lowercase, drop punctuation, expand abbreviations, collapse spaces. */
export function normalizeAddress(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBREVIATIONS[t] ?? t)
    .join(" ");
}

interface AddressParts {
  pincode: string | null;
  doors: Set<string>;
  words: Set<string>;
}

function partsOf(text: string): AddressParts {
  const normalized = normalizeAddress(text);
  const pincode = normalized.match(PINCODE)?.[0] ?? null;
  const tokens = normalized.split(" ").filter(Boolean);
  const doors = new Set<string>();
  const words = new Set<string>();
  tokens.forEach((t, i) => {
    if (t === pincode) return;
    if (/\d/.test(t)) {
      // A floor is not a door: skip "3rd floor" and "floor 3".
      if (ORDINAL.test(t)) return;
      if (tokens[i - 1] === "floor") return;
      doors.add(t);
      return;
    }
    if (t.length > 1 && !STOPWORDS.has(t)) words.add(t);
  });
  return { pincode, doors, words };
}

export interface AddressMatchResult {
  score: number;
  match: boolean;
}

/** Share of the smaller address's words found in the other. */
const MATCH_THRESHOLD = 0.6;
const MIN_SHARED_WORDS = 2;

/**
 * Whether `theirs` (as listed on a public record) is our address.
 *
 * Tolerant of word order, punctuation and abbreviations. Two six digit
 * pincodes that differ, or two sets of door numbers with nothing in common,
 * rule a match out whatever else lines up. A missing pincode or door number on
 * either side does not.
 */
export function addressMatch(ours: string, theirs: string): AddressMatchResult {
  const a = partsOf(ours);
  const b = partsOf(theirs);

  if (a.pincode && b.pincode && a.pincode !== b.pincode) return { score: 0, match: false };

  let doorConflict = false;
  let doorShared = false;
  if (a.doors.size > 0 && b.doors.size > 0) {
    doorShared = [...a.doors].some((d) => b.doors.has(d));
    doorConflict = !doorShared;
  }

  const smaller = Math.min(a.words.size, b.words.size);
  const shared = [...a.words].filter((w) => b.words.has(w)).length;
  const ratio = smaller === 0 ? 0 : shared / smaller;

  let score = ratio * 0.8;
  if (a.pincode && a.pincode === b.pincode) score += 0.1;
  if (doorShared) score += 0.1;
  if (doorConflict) score = Math.min(score, 0.3);
  score = Math.round(score * 1000) / 1000;

  const match = !doorConflict && shared >= MIN_SHARED_WORDS && ratio >= MATCH_THRESHOLD;
  return { score, match };
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export const ADDRESS_VERDICTS = ["in_use", "likely", "inconclusive", "clear"] as const;
export type AddressVerdict = (typeof ADDRESS_VERDICTS)[number];

export interface VerdictSources {
  /** GST portal for the client's GSTIN: lists our address, no longer does, or could not be read. */
  gst: "listed" | "removed" | "unavailable";
  /** MCA registered office. not_applicable when the client has no company record. */
  mca: "listed" | "removed" | "not_applicable";
  /** Our address still shows on the client's website or listings. */
  websiteSigns: boolean;
  /** Mail for the client was logged at reception recently. */
  mailLogged: boolean;
}

/**
 * GST and MCA are the strong sources: either listing our address means the
 * address is in use. Without a strong listing, an unreadable GST portal makes
 * the check inconclusive (a clear answer must not rest on a failed lookup,
 * even if weak signals exist). Otherwise weak signals (website, mail) make it
 * likely, and no signal at all is clear.
 */
export function verdictFromSources(s: VerdictSources): AddressVerdict {
  if (s.gst === "listed" || s.mca === "listed") return "in_use";
  if (s.gst === "unavailable") return "inconclusive";
  if (s.websiteSigns || s.mailLogged) return "likely";
  return "clear";
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** Days since lapse of the first checks; after the last, one every CHECK_INTERVAL_DAYS. */
export const EARLY_CHECK_DAYS = [7, 15, 30] as const;
export const CHECK_INTERVAL_DAYS = 30;
/** A proforma is drafted on day 0 and every BILLING_CYCLE_DAYS after. */
export const BILLING_CYCLE_DAYS = 30;

export function isCheckDay(dayOffset: number): boolean {
  if (!Number.isInteger(dayOffset) || dayOffset < 1) return false;
  return (EARLY_CHECK_DAYS as readonly number[]).includes(dayOffset) ||
    (dayOffset > 30 && dayOffset % CHECK_INTERVAL_DAYS === 0);
}

/** The first check day strictly after `dayOffset`. */
export function nextCheckDay(dayOffset: number): number {
  const early = EARLY_CHECK_DAYS.find((d) => d > dayOffset);
  if (early !== undefined) return early;
  return (Math.floor(dayOffset / CHECK_INTERVAL_DAYS) + 1) * CHECK_INTERVAL_DAYS;
}

export function isBillingCycleDay(dayOffset: number): boolean {
  return Number.isInteger(dayOffset) && dayOffset >= 0 && dayOffset % BILLING_CYCLE_DAYS === 0;
}

/** 1 on day 0, 2 on day 30, ...; null when the day is not a cycle day. */
export function billingCycleNumber(dayOffset: number): number | null {
  return isBillingCycleDay(dayOffset) ? dayOffset / BILLING_CYCLE_DAYS + 1 : null;
}

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

export interface CheckForRelease {
  checkedAt: string | Date;
  verdict: AddressVerdict;
}

/** The two clear checks must be at least this far apart. */
export const MIN_CLEAR_GAP_DAYS = 7;

/**
 * 'ready' when the latest two checks (by time, however the list is ordered)
 * are both clear and at least MIN_CLEAR_GAP_DAYS apart. Anything else, including
 * a single check, or a clear one followed by another verdict, continues.
 */
export function releaseDecision(checks: CheckForRelease[]): "ready" | "continue" {
  if (checks.length < 2) return "continue";
  const sorted = [...checks].sort(
    (x, y) => new Date(x.checkedAt).getTime() - new Date(y.checkedAt).getTime(),
  );
  const prev = sorted[sorted.length - 2];
  const last = sorted[sorted.length - 1];
  if (prev.verdict !== "clear" || last.verdict !== "clear") return "continue";
  const gapMs = new Date(last.checkedAt).getTime() - new Date(prev.checkedAt).getTime();
  return gapMs >= MIN_CLEAR_GAP_DAYS * 86_400_000 ? "ready" : "continue";
}

// ---------------------------------------------------------------------------
// Holdover rate
// ---------------------------------------------------------------------------

export const VO_HOLDOVER_SETTING_KEYS = {
  upliftPct: "vo_holdover_uplift_pct",
  stepPct: "vo_holdover_step_pct",
  periodMonths: "vo_holdover_period_months",
  capPct: "vo_holdover_cap_pct",
} as const;

export interface HoldoverSettings {
  /** Uplift on the monthly rate for the first period, in percent. */
  upliftPct: number;
  /** Added after each completed period, in percent. */
  stepPct: number;
  /** Months per period. */
  periodMonths: number;
  /** The uplift never exceeds this, in percent. */
  capPct: number;
}

export const DEFAULT_HOLDOVER_SETTINGS: HoldoverSettings = {
  upliftPct: 25,
  stepPct: 10,
  periodMonths: 3,
  capPct: 60,
};

/** Reads the four app_settings values; missing or non numeric ones fall back to the defaults. */
export function parseHoldoverSettings(
  raw: Partial<Record<string, string | null | undefined>>,
): HoldoverSettings {
  const num = (key: string, fallback: number) => {
    const v = raw[key];
    if (v === null || v === undefined || v.trim() === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const d = DEFAULT_HOLDOVER_SETTINGS;
  const period = num(VO_HOLDOVER_SETTING_KEYS.periodMonths, d.periodMonths);
  return {
    upliftPct: num(VO_HOLDOVER_SETTING_KEYS.upliftPct, d.upliftPct),
    stepPct: num(VO_HOLDOVER_SETTING_KEYS.stepPct, d.stepPct),
    periodMonths: period >= 1 ? Math.floor(period) : d.periodMonths,
    capPct: num(VO_HOLDOVER_SETTING_KEYS.capPct, d.capPct),
  };
}

/** Uplift percent for holdover month n (1 based): min(cap, start + step * floor((n-1)/period)). */
export function holdoverUpliftPct(n: number, settings: HoldoverSettings): number {
  const month = Math.max(1, Math.floor(n));
  const period = Math.max(1, settings.periodMonths);
  return Math.min(settings.capPct, settings.upliftPct + settings.stepPct * Math.floor((month - 1) / period));
}

/**
 * The annual equivalent of a case rate. cases.rate means different things by
 * term: for a term of 12 months or less it is the fee for the whole term, so
 * the annual equivalent is rate * 12 / tenureMonths; for 24, 36 or 48 months
 * it is already the annual rate.
 */
export function annualEquivalentRate(rate: number, tenureMonths: number): number {
  if (tenureMonths > 12) return rate;
  const months = tenureMonths >= 1 ? tenureMonths : 12;
  return (rate * 12) / months;
}

/**
 * The pre GST amount of holdover proforma n: one twelfth of the annual
 * equivalent of cases.rate (see annualEquivalentRate), uplifted for month n,
 * rounded to 2 decimals.
 */
export function holdoverAmount(params: {
  rate: number;
  tenureMonths: number;
  n: number;
  settings: HoldoverSettings;
}): number {
  const uplift = holdoverUpliftPct(params.n, params.settings);
  const monthly = annualEquivalentRate(params.rate, params.tenureMonths) / 12;
  return Math.round((monthly * (1 + uplift / 100) + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Proforma planning
// ---------------------------------------------------------------------------

export type HoldoverPiReason =
  | "create"
  | "not_cycle_day"
  | "released"
  | "proof_verified"
  | "no_verdict"
  | "not_in_use"
  | "already_created";

/**
 * Whether to draft a holdover proforma today. Only on a billing cycle day,
 * only while the latest verdict is in_use or likely, never once the address is
 * released or deregistration proof is verified, and never twice for one cycle
 * (existingPiCount is how many holdover proformas the case already has).
 */
export function planHoldoverPi(params: {
  latestVerdict: AddressVerdict | null;
  released: boolean;
  proofVerified: boolean;
  day: number;
  existingPiCount: number;
}): { create: boolean; reason: HoldoverPiReason } {
  const { latestVerdict, released, proofVerified, day, existingPiCount } = params;
  if (released) return { create: false, reason: "released" };
  if (proofVerified) return { create: false, reason: "proof_verified" };
  const cycle = billingCycleNumber(day);
  if (cycle === null) return { create: false, reason: "not_cycle_day" };
  if (latestVerdict === null) return { create: false, reason: "no_verdict" };
  if (latestVerdict !== "in_use" && latestVerdict !== "likely") {
    return { create: false, reason: "not_in_use" };
  }
  if (existingPiCount >= cycle) return { create: false, reason: "already_created" };
  return { create: true, reason: "create" };
}
