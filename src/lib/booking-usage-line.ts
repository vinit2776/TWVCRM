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
  /** Printed under the description so the customer can follow the sum (proformas hide Qty and Rate columns). */
  workings?: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "Rs. 1,000" / "Rs. 12.5" (plain text: the PDF font cannot draw the rupee sign). */
export function formatRs(n: number): string {
  return "Rs. " + new Intl.NumberFormat("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function monthYearLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** Workings for metered usage: "158 pages used, 70 free = 88 over x Rs. 5 per page". */
export function overageWorkings(p: { used: number; free: number; over: number; rate: number; unit: string }): string {
  const plural = (n: number) => (round2(n) === 1 ? p.unit : `${p.unit}s`);
  return `${fmtHours(p.used)} ${plural(p.used)} used, ${fmtHours(p.free)} free = ${fmtHours(p.over)} over x ${formatRs(p.rate)} per ${p.unit}`;
}

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
  const quantity = Number(c.quantity) || 1;
  const asIs: UsageLine = { description: c.description, quantity, unitPrice, amount };

  // A hand-added charge (no booking, no metered kind): show the sum behind its amount.
  if (!c.booking_charge_kind && !c.booking?.booking_number) {
    return unitPrice > 0 ? { ...asIs, workings: `${fmtHours(quantity)} x ${formatRs(unitPrice)}` } : asIs;
  }
  if (c.booking_charge_kind !== "pooled_usage" || !c.booking?.booking_number || unitPrice <= 0) return asIs;

  const used = Number(c.quantity) || 0;
  const billed = round2(amount / unitPrice);
  const free = Math.max(0, round2(used - billed));
  const window = c.booking.check_in_at && c.booking.check_out_at
    ? `${istTime(c.booking.check_in_at)} to ${istTime(c.booking.check_out_at)}: `
    : "";

  return {
    description: `${c.facility_name || "Facility"}: ${dayMonth(c.charge_date)}, ${c.booking.booking_number}`,
    workings: `${window}${fmtHours(used)} h used, ${fmtHours(free)} h free = ${fmtHours(billed)} h billed x ${formatRs(unitPrice)} per hour`,
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

/** What staff see for one booking-linked charge on the internal statement view. */
export interface BookingChargeView {
  bookingId: string | null;
  bookingNumber: string;
  /** "Conference Room · 1 Jul" */
  title: string;
  /** "2:39 pm to 8:06 pm · used 5.5 h, free 3 h" */
  detail: string;
  usedHours: number;
  freeHours: number;
  billedHours: number;
  unitPrice: number;
}

export interface StaffChargeInput extends UsageChargeRow {
  is_waived?: boolean | null;
  status?: string | null;
  original_unit_price?: number | null;
  original_total?: number | null;
}

/**
 * Null for anything that is not a booking charge (ad-hoc, print, legacy kinds) so
 * the caller keeps its existing single-line rendering. A waived charge has its
 * money zeroed, so hours billed come from the snapshot taken at waive time.
 */
export function bookingChargeView(c: StaffChargeInput): BookingChargeView | null {
  const input = toUsageLineInput(c);
  const booking = input.booking as (typeof input.booking & { id?: string | null }) | null;
  if (c.booking_charge_kind !== "pooled_usage" || !booking?.booking_number) return null;

  // Two waive paths exist: the usage board zeroes total/unit_price and snapshots the
  // originals, while the statement's own waive only sets is_waived and keeps the amount.
  // Either way, the hours that were billable come from whichever still holds the money.
  const unitPrice = Number(c.unit_price) || Number(c.original_unit_price ?? 0) || 0;
  const amount = Number(c.total) || Number(c.original_total ?? 0) || 0;
  const used = Number(c.quantity) || 0;
  const billed = unitPrice > 0 ? round2(amount / unitPrice) : 0;
  const free = Math.max(0, round2(used - billed));
  const window = booking.check_in_at && booking.check_out_at ? `${istTime(booking.check_in_at)} to ${istTime(booking.check_out_at)} · ` : "";

  return {
    bookingId: booking.id ?? null,
    bookingNumber: booking.booking_number,
    title: `${input.facility_name || "Facility"} · ${dayMonth(input.charge_date)}`,
    detail: `${window}used ${fmtHours(used)} h, free ${fmtHours(free)} h`,
    usedHours: used,
    freeHours: free,
    billedHours: billed,
    unitPrice,
  };
}

export interface BookingChargeTotals { count: number; usedHours: number; freeHours: number; billedHours: number }

/** Month total across live (non-waived) booking charges; callers show it from 2 bookings up. */
export function bookingChargeTotals(views: BookingChargeView[]): BookingChargeTotals {
  return {
    count: views.length,
    usedHours: round2(views.reduce((s, v) => s + v.usedHours, 0)),
    freeHours: round2(views.reduce((s, v) => s + v.freeHours, 0)),
    billedHours: round2(views.reduce((s, v) => s + v.billedHours, 0)),
  };
}
