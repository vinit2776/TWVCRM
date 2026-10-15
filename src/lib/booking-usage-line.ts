/**
 * One printed line per booking that went over its facility's free quota.
 *
 * A pooled_usage charge stores the hours USED in `quantity` and only the
 * over-quota money in `total`, so printing `quantity × unit_price` next to
 * `total` reads as arithmetic that does not add up (4 × ₹1,000 = ₹1,000).
 * The customer-facing line instead shows hours billed (total ÷ rate), which
 * always multiplies back to the amount, and carries the used / free split
 * and the check-in/out window in its description.
 */

export interface BookingUsageChargeInput {
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  charge_date: string;
  booking_charge_kind?: string | null;
  booking?: { booking_number?: string | null; check_in_at?: string | null; check_out_at?: string | null } | null;
  facility_name?: string | null;
}

export interface UsageLine {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 5.5 -> "5.5", 4 -> "4", 4.58 -> "4.58" */
export function fmtHours(n: number): string {
  return String(round2(n));
}

function istTime(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(iso))
    .toLowerCase();
}

function dayMonth(isoDate: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${isoDate}T00:00:00Z`));
}

export function usageLine(c: BookingUsageChargeInput): UsageLine {
  const unitPrice = Number(c.unit_price) || 0;
  const amount = Number(c.total) || 0;
  const asIs: UsageLine = { description: c.description, quantity: Number(c.quantity) || 1, unitPrice, amount };

  if (c.booking_charge_kind !== "pooled_usage" || !c.booking?.booking_number || unitPrice <= 0) return asIs;

  const used = Number(c.quantity) || 0;
  const billed = round2(amount / unitPrice);
  const free = Math.max(0, round2(used - billed));
  const window = c.booking.check_in_at && c.booking.check_out_at
    ? `, ${istTime(c.booking.check_in_at)} to ${istTime(c.booking.check_out_at)}`
    : "";

  return {
    description: `${c.facility_name || "Facility"}: ${dayMonth(c.charge_date)}, ${c.booking.booking_number}${window} (used ${fmtHours(used)} h, free ${fmtHours(free)} h)`,
    quantity: billed,
    unitPrice,
    amount,
  };
}

/** A usage_charges row as selected for printing, with its booking and facility embedded. */
export interface UsageChargeRow {
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  charge_date?: string | null;
  booking_charge_kind?: string | null;
  booking?: unknown;
  contract_facility?: unknown;
}

// PostgREST types a to-one embed as an object or a one-element array depending on inference.
function embedded<T>(v: unknown): T | null {
  return (Array.isArray(v) ? v[0] : v) as T | null ?? null;
}

export function toUsageLineInput(c: UsageChargeRow): BookingUsageChargeInput {
  return {
    description: c.description,
    quantity: Number(c.quantity),
    unit_price: Number(c.unit_price),
    total: Number(c.total),
    charge_date: c.charge_date ?? "",
    booking_charge_kind: c.booking_charge_kind ?? null,
    booking: embedded<NonNullable<BookingUsageChargeInput["booking"]>>(c.booking),
    facility_name: embedded<{ name: string | null }>(c.contract_facility)?.name ?? null,
  };
}
