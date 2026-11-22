import type { VoRatePurpose } from "@/lib/constants";

export interface DirectRateRow {
  id?: string;
  purpose: VoRatePurpose | string;
  location_id: string | null;
  guide_fee: number;
  floor_fee: number | null;
  default_term_months: number;
  version?: number;
}

export type RateMatch<T> = { row: T; how: "exact" | "any" };

/** Exact location first, then the same purpose with "Any location", else null. */
export function lookupDirectRate<T extends Pick<DirectRateRow, "purpose" | "location_id">>(
  rows: T[],
  purpose: string,
  locationId: string | null,
): RateMatch<T> | null {
  if (locationId) {
    const exact = rows.find((r) => r.purpose === purpose && r.location_id === locationId);
    if (exact) return { row: exact, how: "exact" };
  }
  const any = rows.find((r) => r.purpose === purpose && r.location_id === null);
  return any ? { row: any, how: "any" } : null;
}

export type QuoteClass = "above_guide" | "at_guide" | "below_guide" | "below_floor";

export function classifyQuote(row: Pick<DirectRateRow, "guide_fee" | "floor_fee">, price: number): QuoteClass {
  if (row.floor_fee !== null && price < row.floor_fee) return "below_floor";
  if (price > row.guide_fee) return "above_guide";
  if (price === row.guide_fee) return "at_guide";
  return "below_guide";
}

/**
 * Owner's rate meaning: for a term of 12 months or less the rate is the fee for the whole
 * term (11 and 12 months are 1x). For 24, 36 and 48 months the rate is annual, so the
 * term fee is rate x months / 12.
 */
export function scaleForTerm(amount: number, termMonths: number): number {
  const years = termMonths <= 12 ? 1 : termMonths / 12;
  return Math.round(amount * years * 100) / 100;
}

/** Winning customers pay more, so lean upward when the win rate is high. */
export function suggestedAsk(input: { guide: number; avgWon: number | null; winRate: number | null }): number {
  const { guide, avgWon, winRate } = input;
  if (winRate !== null && winRate >= 60 && avgWon !== null && avgWon > 0) {
    return Math.round(Math.max(guide, avgWon * 1.05) / 100) * 100;
  }
  return guide;
}

export interface QuoteOutcome {
  price: number;
  outcome: "won" | "lost" | "expired";
  at: string | Date;
}

export interface Trend {
  won: number;
  avgWon: number | null;
  /** Percent (0 to 100) of quotes in the window that were won; null with no quotes. */
  winRate: number | null;
}

export function computeTrend(outcomes: QuoteOutcome[], windowDays: number, now: Date): Trend {
  const since = now.getTime() - windowDays * 86_400_000;
  const inWindow = outcomes.filter((o) => {
    const t = new Date(o.at).getTime();
    return t >= since && t <= now.getTime();
  });
  const wins = inWindow.filter((o) => o.outcome === "won");
  const avgWon = wins.length ? Math.round((wins.reduce((s, o) => s + o.price, 0) / wins.length) * 100) / 100 : null;
  const winRate = inWindow.length ? Math.round((wins.length / inWindow.length) * 1000) / 10 : null;
  return { won: wins.length, avgWon, winRate };
}
