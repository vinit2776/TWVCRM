interface PrepaidPackageScope {
  workspace_type?: string | null;
  space_id?: string | null;
}

/**
 * A package is a bundle of units for a specific kind of space, not a wallet.
 * Legacy packages with neither field set are unrestricted; new ones must
 * always carry at least one (enforced at creation).
 */
export function isPrepaidApplicableToSpace(
  pkg: PrepaidPackageScope | null | undefined,
  space: { id: string; workspace_type?: string | null },
): boolean {
  if (pkg?.space_id && pkg.space_id !== space.id) return false;
  if (pkg?.workspace_type && pkg.workspace_type !== space.workspace_type) return false;
  return true;
}

const normaliseCompany = (name?: string | null) => (name ?? "").trim().toLowerCase();

/**
 * A package bought by a lead is that lead's own. A package bought for a
 * company (no lead) can be used by any contact whose lead record carries
 * the same company name.
 */
export function isPrepaidOwnedByCustomer(
  purchase: { lead_id?: string | null; company_name?: string | null },
  customer: { leadId?: string | null; company?: string | null },
): boolean {
  if (purchase.lead_id && purchase.lead_id === customer.leadId) return true;
  const owner = normaliseCompany(purchase.company_name);
  return owner !== "" && owner === normaliseCompany(customer.company);
}

/** Escape LIKE wildcards so a company name is matched literally by ilike. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const IST_OFFSET = "+05:30";

/** Today's calendar date in India, as YYYY-MM-DD. */
export function istDateString(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDaysToDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Hours from `now` until the booking starts (negative once it has started). */
export function hoursBeforeStart(bookingDate: string, startTime: string, now: Date = new Date()): number {
  const hhmm = startTime.slice(0, 5);
  const start = new Date(`${bookingDate}T${hhmm}:00${IST_OFFSET}`);
  return Math.round(((start.getTime() - now.getTime()) / 3_600_000) * 100) / 100;
}

export interface PrepaidRestoreDecision {
  restore: boolean;
  reason: string;
}

/**
 * Credits go back only for a cancellation made at least `windowHours` before
 * the start. A no-show never restores; a null window means "no restores".
 */
export function decidePrepaidRestore(input: {
  trigger: "cancel" | "no_show";
  hoursBeforeStart: number;
  windowHours: number | null;
}): PrepaidRestoreDecision {
  if (input.trigger === "no_show") return { restore: false, reason: "No-show: credits are not restored" };
  if (input.windowHours === null) return { restore: false, reason: "This package does not restore credits on cancellation" };
  if (input.hoursBeforeStart >= input.windowHours) {
    return { restore: true, reason: `Cancelled ${input.hoursBeforeStart} hrs before start, free cancellation up to ${input.windowHours} hrs` };
  }
  return { restore: false, reason: `Cancelled ${input.hoursBeforeStart} hrs before start, inside the ${input.windowHours} hr window` };
}

/** A purchase with no location rows (sold before locations existed) is valid everywhere. */
export function isPrepaidValidAtLocation(locationIds: string[], locationId: string | null | undefined): boolean {
  if (locationIds.length === 0) return true;
  return !!locationId && locationIds.includes(locationId);
}
