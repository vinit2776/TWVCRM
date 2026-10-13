/**
 * Label for where a usage charge came from. The underlying `source` is only
 * which table holds the row: "manual" is the general usage_charges table, which
 * also holds every booking charge the system posts at checkout. Reading
 * "Manual" there suggested someone had keyed the charge in by hand.
 */
export type UsageChargeSource = "manual" | "print" | "facility";

export function usageSourceLabel(source: UsageChargeSource, hasBooking: boolean, style: "short" | "long" = "short"): string {
  if (source === "print") return style === "short" ? "Print" : "Print log";
  if (source === "facility") return style === "short" ? "Facility" : "Facility usage";
  if (hasBooking) return style === "short" ? "Booking" : "Booking charge";
  return "Added by hand";
}
