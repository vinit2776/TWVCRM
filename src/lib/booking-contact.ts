/**
 * The one rule for which email a booking's customer emails go to by default: the
 * lead's email, else the guest email entered on the booking. It is the address the
 * booking page shows as "Email". The confirmation, payment link and PI already used
 * this; the access PIN used the guest email first, so one booking could send its PIN
 * to a different address from everything else.
 */
export function bookingContactEmail(booking: {
  guest_email?: string | null;
  lead?: { email?: string | null } | null;
}): string | null {
  return booking.lead?.email || booking.guest_email || null;
}
