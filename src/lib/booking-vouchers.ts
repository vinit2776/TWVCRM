/**
 * Shared "email the issued WiFi voucher codes for a booking" logic.
 *
 * Used by two callers:
 *   - POST /api/bookings/[id]/vouchers        — fires this automatically
 *     right after issuing new codes (best-effort, never fails the issuance).
 *   - POST /api/bookings/[id]/vouchers/email   — manual "Send to customer"
 *     button on the booking detail page (staff-triggered resend).
 *
 * Kept in one place so the HTML template and code-resolution logic (legacy
 * UniFi rows that never had unifi_code persisted) aren't duplicated between
 * the two routes.
 *
 * WhatsApp delivery is intentionally out of scope — there is no
 * MSG91-approved template for WiFi vouchers (see
 * src/lib/provision-booking-access.ts:193).
 *
 * Never log the voucher codes themselves.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { resend, EMAIL_FROM } from "@/lib/mailer";
import { logAudit } from "@/lib/audit";
import { getUnifiVoucher, siteConfigFromLocation, isUnifiLocation } from "@/lib/unifi";

export type SendBookingVoucherEmailResult =
  | { ok: true; sent: number; recipient: string; emailedAt: string }
  | { ok: false; reason: string };

/**
 * Max number of *active* WiFi voucher issuances a booking may hold at once.
 *
 * Product decision (owner-specified, do not substitute a different metric):
 *   - Daily-priced spaces (day passes): cap = seats purchased (booking.quantity).
 *     One real booking ended up with 3 vouchers for 1 seat before this cap
 *     existed — quantity is the number of seats actually paid for.
 *   - Everything else (hourly rooms): cap = the space's `capacity`.
 *     Deliberately NOT `num_attendees` — that field is optional and often
 *     left blank, and capping on it would block staff from issuing vouchers
 *     for a fully-attended room whose attendee count was never entered.
 *   - If neither value is available/positive, cap = 1.
 *
 * Always at least 1 — a booking should always be able to get one code.
 */
export function computeVoucherSeatCap(
  booking: { pricing_model?: string | null; quantity?: number | null },
  space: { capacity?: number | null } | null | undefined
): number {
  if (booking.pricing_model === "daily") {
    const qty = Number(booking.quantity);
    return Number.isFinite(qty) && qty > 0 ? Math.max(1, Math.floor(qty)) : 1;
  }
  const capacity = Number(space?.capacity);
  return Number.isFinite(capacity) && capacity > 0 ? Math.max(1, Math.floor(capacity)) : 1;
}

function formatDateIST(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr + "T00:00:00+05:30").toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Resolves booking + active voucher issuances, sends the email, stamps
 * `emailed_at` on success, and logs an audit entry. Returns a result object
 * instead of throwing — callers decide how to surface failure (HTTP error
 * response for the manual endpoint, silent best-effort for the auto-send).
 */
export async function sendBookingVoucherEmail(
  supabase: SupabaseClient,
  params: {
    bookingId: string;
    senderName: string;
    performedBy: string | null;
    emailOverride?: string | null;
  }
): Promise<SendBookingVoucherEmailResult> {
  const { bookingId, senderName, performedBy, emailOverride } = params;

  const { data: booking, error: bookingError } = await supabase
    .from("bookings")
    .select(
      "id, booking_number, booking_date, guest_email, location_id, space:spaces!bookings_space_id_fkey(name), lead:leads!bookings_lead_id_fkey(first_name, last_name, email)"
    )
    .eq("id", bookingId)
    .single();

  if (bookingError || !booking) {
    return { ok: false, reason: "Booking not found" };
  }

  const lead = booking.lead as unknown as { first_name?: string; last_name?: string; email?: string } | null;
  const recipientEmail = emailOverride || booking.guest_email || lead?.email;

  if (!recipientEmail) {
    return { ok: false, reason: "No email address on file for this booking" };
  }

  const { data: issuances, error: issuanceError } = await supabase
    .from("voucher_issuances")
    .select(
      "*, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(id, voucher_code, status, metadata, expires_at, validity_days)"
    )
    .eq("booking_id", bookingId)
    .eq("is_active", true)
    .order("seat_number", { ascending: true });

  if (issuanceError) {
    return { ok: false, reason: issuanceError.message };
  }

  if (!issuances || issuances.length === 0) {
    return { ok: false, reason: "No active vouchers have been issued for this booking" };
  }

  // Resolve each issuance's code, recovering legacy UniFi rows (no unifi_code
  // stored) from the controller and backfilling so future sends skip the round-trip.
  let locationRow: { unifi_site_id?: string | null; unifi_console_id?: string | null; wifi_voucher_mode?: string | null } | null = null;

  const resolvedCodes: { issuanceId: string; code: string | null }[] = [];
  for (const issuance of issuances) {
    const row = issuance as Record<string, unknown>;
    let code: string | null =
      (issuance.voucher?.voucher_code as string | undefined) ||
      (row.unifi_code as string | undefined) ||
      (row.ruijie_code as string | undefined) ||
      null;

    if (!code && row.unifi_voucher_id) {
      try {
        if (locationRow === null) {
          const { data } = await supabase
            .from("locations")
            .select("unifi_site_id, unifi_console_id, wifi_voucher_mode")
            .eq("id", booking.location_id)
            .single();
          locationRow = data;
        }
        if (locationRow && isUnifiLocation(locationRow)) {
          const siteConfig = siteConfigFromLocation(locationRow);
          const unifiVoucher = await getUnifiVoucher(row.unifi_voucher_id as string, siteConfig);
          if (unifiVoucher?.code) {
            code = unifiVoucher.code;
            // Backfill so future sends don't need the API call
            await supabase
              .from("voucher_issuances")
              .update({ unifi_code: unifiVoucher.code })
              .eq("id", issuance.id);
          }
        }
      } catch (err) {
        console.error("[booking-voucher-email] UniFi code lookup failed:", err);
      }
    }

    resolvedCodes.push({ issuanceId: issuance.id, code });
  }

  const codes = resolvedCodes.map((r) => r.code).filter((c): c is string => !!c);

  if (codes.length === 0) {
    return {
      ok: false,
      reason:
        "No voucher codes are available to send. The UniFi controller may be unreachable.",
    };
  }

  const customerName = lead?.first_name || booking.guest_email?.split("@")[0] || "Guest";
  const spaceName = (booking.space as unknown as { name?: string } | null)?.name || "Room";
  const bookingDate = formatDateIST(booking.booking_date);

  try {
    const sendResult = await resend.emails.send({
      from: EMAIL_FROM,
      to: [recipientEmail],
      subject: `Your WiFi Access Code${codes.length > 1 ? "s" : ""} — The WorkVilla`,
      html: buildBookingVoucherEmailHTML({
        recipientName: customerName,
        codes,
        bookingNumber: booking.booking_number,
        spaceName,
        bookingDate,
        senderName,
      }),
    });

    if (sendResult.error) {
      console.error("Resend API error:", sendResult.error);
      return { ok: false, reason: sendResult.error.message || "Email delivery failed" };
    }
  } catch (error) {
    console.error("Booking voucher email error:", error);
    return { ok: false, reason: "Failed to send email" };
  }

  const now = new Date().toISOString();
  const sentIssuanceIds = resolvedCodes.filter((r) => r.code).map((r) => r.issuanceId);
  if (sentIssuanceIds.length > 0) {
    await supabase.from("voucher_issuances").update({ emailed_at: now }).in("id", sentIssuanceIds);
  }

  // Never log the voucher codes themselves — only count + recipient.
  logAudit(supabase, {
    entityType: "voucher",
    entityId: bookingId,
    action: "email_sent",
    performedBy,
    changes: {
      booking_id: { old: null, new: bookingId },
      emailed_count: { old: null, new: sentIssuanceIds.length },
      recipient: { old: null, new: recipientEmail },
    },
  });

  return { ok: true, sent: sentIssuanceIds.length, recipient: recipientEmail, emailedAt: now };
}

function buildBookingVoucherEmailHTML(params: {
  recipientName: string;
  codes: string[];
  bookingNumber: string;
  spaceName: string;
  bookingDate: string;
  senderName: string;
}) {
  const { recipientName, codes, bookingNumber, spaceName, bookingDate, senderName } = params;

  const codeBlocks = codes
    .map(
      (code) => `
        <div style="text-align: center; margin: 12px 0; padding: 20px; background: #f0faf5; border-radius: 8px; border: 2px solid #015E65;">
          <p style="color: #015E65; font-size: 32px; font-weight: bold; margin: 0; letter-spacing: 4px; font-family: monospace;">${code}</p>
        </div>`
    )
    .join("");

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #015E65; padding: 24px 32px;">
        <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: bold;">The WorkVilla</h1>
        <p style="color: #00AE6C; margin: 4px 0 0; font-size: 12px;">Your WiFi Access Code${codes.length > 1 ? "s" : ""}</p>
      </div>
      <div style="padding: 32px;">
        <p style="color: #1a1b1e; font-size: 15px;">Hello ${recipientName},</p>
        <p style="color: #333; font-size: 14px;">Here ${codes.length > 1 ? "are your internet access codes" : "is your internet access code"} for your booking at The WorkVilla.</p>

        <!-- Booking details -->
        <table style="border-collapse: collapse; margin: 16px 0; width: 100%;">
          <tr>
            <td style="padding: 8px 16px; color: #666; font-size: 13px; border-bottom: 1px solid #e5e7eb;">Booking</td>
            <td style="padding: 8px 16px; color: #333; font-size: 13px; font-weight: bold; border-bottom: 1px solid #e5e7eb; text-align: right;">${bookingNumber}</td>
          </tr>
          <tr>
            <td style="padding: 8px 16px; color: #666; font-size: 13px; border-bottom: 1px solid #e5e7eb;">Room</td>
            <td style="padding: 8px 16px; color: #333; font-size: 13px; font-weight: bold; border-bottom: 1px solid #e5e7eb; text-align: right;">${spaceName}</td>
          </tr>
          <tr>
            <td style="padding: 8px 16px; color: #666; font-size: 13px;">Date</td>
            <td style="padding: 8px 16px; color: #333; font-size: 13px; font-weight: bold; text-align: right;">${bookingDate}</td>
          </tr>
        </table>

        <!-- Voucher Code(s) -->
        <p style="color: #015E65; font-size: 13px; margin: 20px 0 4px; text-align: center;">Your Voucher Code${codes.length > 1 ? "s" : ""}</p>
        ${codeBlocks}

        <!-- WiFi Instructions -->
        <div style="margin-top: 24px; padding: 16px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
          <h3 style="color: #015E65; margin: 0 0 12px; font-size: 14px;">How to Connect</h3>
          <ol style="color: #555; font-size: 13px; margin: 0; padding-left: 20px; line-height: 1.8;">
            <li>Connect to the WiFi network: <strong style="color: #015E65;">Workvilla Clients</strong></li>
            <li>A login page will appear in your browser</li>
            <li>Enter the voucher code shown above</li>
            <li>Click <strong>Connect</strong> — you&apos;re online!</li>
          </ol>
          <p style="color: #888; font-size: 12px; margin: 12px 0 0;">Each code supports up to 2 devices. If you need more codes, please contact The WorkVilla front desk.</p>
        </div>

        <p style="color: #333; font-size: 14px; margin-top: 24px;">If you have any questions, please reach out to the front desk or email us.</p>
        <p style="color: #333; font-size: 14px;">Best regards,<br/><strong>${senderName}</strong><br/>The WorkVilla</p>
      </div>
      <div style="background-color: #015E65; padding: 16px 32px; text-align: center;">
        <p style="color: #ffffff; margin: 0; font-size: 11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
        <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
        <p style="color: rgba(255,255,255,0.7); margin: 4px 0 0; font-size: 10px;">GST: 33AAACU4245J1ZF</p>
        <p style="color: #00AE6C; margin: 4px 0 0; font-size: 10px;">www.theworkvilla.com</p>
      </div>
    </div>
  `;
}
