/**
 * How long a UniFi voucher can run, and how many days a stored one has left.
 *
 * UniFi rejects a voucher whose duration is too large (`api.err.IncorrectNumberRange`),
 * so a contract longer than the cap gets a voucher for the cap and is renewed
 * before it runs out (cron/voucher-expiry-alert → Replace on the contract).
 * Pure date logic only — no server imports, so the client list can use it too.
 */

/** One year: comfortably under any limit UniFi enforces on a single voucher. */
export const MAX_UNIFI_VOUCHER_DAYS = 365;
export const MAX_UNIFI_VOUCHER_MINUTES = MAX_UNIFI_VOUCHER_DAYS * 24 * 60;

/** Staff are alerted this many days before a capped voucher stops working. */
export const VOUCHER_RENEWAL_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Today's calendar date in IST as a UTC-midnight timestamp. */
function istTodayMs(now: Date): number {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
}

function dateOnlyMs(date: string | Date): number {
  const d = typeof date === "string" ? new Date(date.slice(0, 10)) : date;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The date a voucher issued now will stop working: the contract end, or the cap if sooner. */
export function voucherValidUntil(contractEnd: string | Date, now: Date = new Date()): string {
  const capMs = istTodayMs(now) + MAX_UNIFI_VOUCHER_DAYS * DAY_MS;
  return new Date(Math.min(dateOnlyMs(contractEnd), capMs)).toISOString().slice(0, 10);
}

/** True when the contract outlasts what one voucher can cover, so it will need renewing. */
export function voucherNeedsRenewalLater(contractEnd: string | Date, now: Date = new Date()): boolean {
  return dateOnlyMs(contractEnd) > istTodayMs(now) + MAX_UNIFI_VOUCHER_DAYS * DAY_MS;
}

/** Whole days left including today (0 = last day). Negative once past. */
export function voucherDaysRemaining(validUntil: string | Date, now: Date = new Date()): number {
  return Math.round((dateOnlyMs(validUntil) - istTodayMs(now)) / DAY_MS);
}
