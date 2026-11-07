/**
 * Helpers for the Log Print Usage dialog's waived-entry markers.
 *
 * The print log stores what was used; a waiver is applied on top of it. The
 * dialog showed the logged pages and a total that still counted waived amounts,
 * so an invoice lower than the log looked wrong.
 */

export interface WaiverInfo {
  waived_at?: string | null;
  waive_reason?: string | null;
  waived_by_user?: { full_name?: string | null } | null;
}

export interface PrintTotals {
  /** What will be billed (waived services excluded). */
  billable: number;
  /** What was waived and so will not be billed. */
  waived: number;
  /** Everything the pages come to before waivers. */
  gross: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function printTotals(input: { bwAmount: number; colourAmount: number; bwWaived: boolean; colourWaived: boolean }): PrintTotals {
  const waived = (input.bwWaived ? input.bwAmount : 0) + (input.colourWaived ? input.colourAmount : 0);
  const gross = input.bwAmount + input.colourAmount;
  return { gross: round2(gross), waived: round2(waived), billable: round2(gross - waived) };
}

/** "Waived by Noorul on 14 Oct: "Over Quota is 88 pages"" (date in IST). */
export function waivedNote(w: WaiverInfo): string {
  const who = w.waived_by_user?.full_name ? ` by ${w.waived_by_user.full_name}` : "";
  const when = w.waived_at
    ? ` on ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }).format(new Date(w.waived_at))}`
    : "";
  const why = w.waive_reason?.trim() ? `: "${w.waive_reason.trim()}"` : "";
  return `Waived${who}${when}${why}`;
}

/**
 * Whether a hand-added charge looks like print usage, from its description or notes.
 * Deliberately loose: it only drives a "check you are not billing twice" warning.
 */
export function isPrintLikeCharge(description: string | null | undefined, notes?: string | null): boolean {
  return /\bprint(?:s|ed|ing|outs?)?\b|\bprint\s*out\b|\bb\s*\/?\s*w\b|\bcolou?r\b/i.test(`${description ?? ""} ${notes ?? ""}`);
}
