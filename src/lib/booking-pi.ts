/**
 * Pure helpers for a booking's proforma invoice (PI) — no Supabase, so they
 * unit test. The PI is a payment request, never a tax invoice: the GST invoice
 * still comes from the Tally Inbox after checkout.
 */

export interface BookingPiAddon {
  description: string;
  quantity: number | string;
  unit_price: number | string;
  amount: number | string;
  gst_rate: number | string;
  gst_amount: number | string;
  total_with_gst: number | string;
}

export interface BookingPiInput {
  booking_number: string | null;
  space_name: string;
  duration_hours: number | string | null;
  total_amount: number | string;
  gst_rate: number | string | null;
  gst_amount: number | string | null;
  total_amount_with_gst: number | string | null;
  addons: BookingPiAddon[];
}

export interface BookingPiLine {
  description: string;
  quantity: number;
  rate: number;
  amount: number;
  gst_rate: number;
  gst_amount: number;
}

export interface BookingPiTotals {
  lines: BookingPiLine[];
  subtotal: number;
  gst: number;
  /** What the customer pays: the booking's stored GST-inclusive total. */
  total: number;
}

const n = (v: number | string | null | undefined) => Number(v) || 0;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** PI-<booking number>, so the PI is traceable to the booking with no second series. */
export function bookingPiNumber(bookingNumber: string | null, bookingId: string): string {
  return `PI-${bookingNumber || bookingId.slice(0, 8).toUpperCase()}`;
}

/**
 * The room line is whatever remains of the booking's ex-GST total after the
 * add-ons, so the lines always add up to the stored figures the payment link
 * and the later GST invoice use.
 */
export function buildBookingPi(input: BookingPiInput): BookingPiTotals {
  const addonLines: BookingPiLine[] = input.addons.map((a) => ({
    description: a.description,
    quantity: n(a.quantity),
    rate: n(a.unit_price),
    amount: n(a.amount),
    gst_rate: n(a.gst_rate),
    gst_amount: n(a.gst_amount),
  }));
  const addonSubtotal = addonLines.reduce((s, l) => s + l.amount, 0);

  const gstRate = n(input.gst_rate);
  const roomAmount = round2(n(input.total_amount) - addonSubtotal);
  const hours = n(input.duration_hours);
  const roomLine: BookingPiLine = {
    description: input.space_name,
    quantity: hours > 0 ? hours : 1,
    rate: hours > 0 ? round2(roomAmount / hours) : roomAmount,
    amount: roomAmount,
    gst_rate: gstRate,
    gst_amount: round2((roomAmount * gstRate) / 100),
  };

  const lines = [roomLine, ...addonLines];
  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const gst = round2(lines.reduce((s, l) => s + l.gst_amount, 0));
  const stored = n(input.total_amount_with_gst);
  return { lines, subtotal, gst, total: stored > 0 ? stored : round2(subtotal + gst) };
}

/** Balance still payable once verified payments are taken off the PI total. */
export function piBalanceDue(total: number, verifiedPaid: number): number {
  return Math.max(0, round2(total - verifiedPaid));
}
