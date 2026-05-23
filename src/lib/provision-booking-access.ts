/**
 * provision-booking-access.ts
 *
 * Core logic for provisioning COSEC access PINs for confirmed bookings.
 * Extracted as a direct-callable function so both the booking creation path
 * and the payment webhook can call it without an internal HTTP self-fetch.
 *
 * Call sites:
 *   - src/app/api/bookings/route.ts (POST — on booking creation when waived)
 *   - src/app/api/payments/webhook/route.ts (on payment_status → paid)
 *   - src/app/api/cosec/booking-access/route.ts (thin HTTP wrapper for manual retrigger)
 */

import { createAdminClient } from "@/lib/supabase/server";
import { provisionUser, bookingCosecId, uuidToRefId, generatePin } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { dltSms } from "@/lib/whatsapp";
import { resend, EMAIL_FROM } from "@/lib/mailer";

export interface DeliveryStatus {
  whatsapp: "sent" | "failed" | "skipped";
  sms:      "sent" | "failed" | "skipped" | "disabled";
  email:    "sent" | "failed" | "skipped";
}

export interface ProvisionResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  pin?: string;
  devicesProvisioned?: number;
  delivery?: DeliveryStatus;
  error?: string;
}

/**
 * Provision COSEC access PIN for a confirmed booking.
 *
 * - Always provisions entry_point devices so every confirmed guest gets building access.
 * - Also provisions the linked room device for conference_room / meeting_room bookings.
 * - Sends PIN via WhatsApp → DLT SMS → email (best-effort, logged on failure).
 * - Idempotent: can be called multiple times safely (upsert on device_id,cosec_user_id).
 */
export async function provisionBookingAccess(booking_id: string): Promise<ProvisionResult> {
  const admin = createAdminClient();

  // Load booking + space + lead
  const { data: booking, error: bookingErr } = await admin
    .from("bookings")
    .select(`
      id, booking_number, booking_date, start_time, end_time,
      space_id, location_id, guest_name, guest_email, guest_phone, booker_phone,
      lead:leads!bookings_lead_id_fkey(first_name, last_name, email, phone),
      space:spaces!bookings_space_id_fkey(id, name, workspace_type, cosec_device_id, location_id)
    `)
    .eq("id", booking_id)
    .single();

  if (bookingErr || !booking) {
    console.error("[provision-booking-access] Booking not found:", booking_id, bookingErr);
    return { ok: false, error: "Booking not found" };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const space = booking.space as any;
  const locationId: string = space?.location_id ?? booking.location_id;

  // Always provision entry_point devices — every confirmed booking gets building access
  const { data: entryDevices } = await admin
    .from("cosec_devices")
    .select("id, label, device_ip, device_port, device_password")
    .eq("location_id", locationId)
    .eq("is_enabled", true)
    .eq("device_category", "entry_point");

  // Only add the room device for conference_room / meeting_room spaces
  const ROOM_TYPES_WITH_DEVICE = ["conference_room", "meeting_room"];
  const isRoomBooking = ROOM_TYPES_WITH_DEVICE.includes(space?.workspace_type ?? "");
  const roomDeviceId: string | null = (isRoomBooking && space?.cosec_device_id) ? space.cosec_device_id : null;

  let roomDevice: { id: string; label: string; device_ip: string; device_port: number; device_password: string } | null = null;
  if (roomDeviceId) {
    const { data: rd } = await admin
      .from("cosec_devices")
      .select("id, label, device_ip, device_port, device_password")
      .eq("id", roomDeviceId)
      .eq("is_enabled", true)
      .single();
    roomDevice = rd ?? null;
  }

  const devicesToProvision = [
    ...(entryDevices ?? []),
    ...(roomDevice ? [roomDevice] : []),
  ];

  if (devicesToProvision.length === 0) {
    console.info("[provision-booking-access] No enabled COSEC devices at location", locationId, "— skipping.");
    return { ok: true, skipped: true, reason: "No enabled COSEC devices at location" };
  }

  // Build valid window: start − 5 min, end + 5 min (all times in IST)
  const bookingDate = booking.booking_date as string; // YYYY-MM-DD
  function toIST(date: string, time: string, offsetMinutes: number): Date {
    const [h, m, s] = (time as string).split(":").map(Number);
    const base = new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s ?? 0).padStart(2, "0")}+05:30`);
    return new Date(base.getTime() + offsetMinutes * 60000);
  }

  const validUntil = toIST(bookingDate, booking.end_time as string, +5);

  const pin         = generatePin();
  const cosecUserId = bookingCosecId(booking_id);
  const cosecRefId  = uuidToRefId(booking_id, 90001, 99999);
  const now         = new Date().toISOString();

  // Provision on all devices — non-fatal if some fail
  const results = await Promise.allSettled(devicesToProvision.map(async (dev) => {
    await provisionUser(
      { ip: dev.device_ip, port: dev.device_port, password: dev.device_password },
      {
        cosecUserId,
        cosecRefId,
        name: ((booking.guest_name as string) || "Visitor").slice(0, 15),
        userActive: true,
        validUntil,
        pin,
        byPassFinger: true, // PIN-only — no biometric enrollment required
      }
    );
    await admin.from("cosec_access_users").upsert({
      device_id:         dev.id,
      cosec_user_id:     cosecUserId,
      cosec_ref_id:      cosecRefId,
      user_type:         "booking",
      entity_id:         booking_id,
      enrollment_status: "provisioned",
      access_pin:        pin,
      valid_until:       validUntil.toISOString(),
      provisioned_at:    now,
      updated_at:        now,
    }, { onConflict: "device_id,cosec_user_id" });
  }));

  const failures = results.filter(r => r.status === "rejected");
  if (failures.length > 0) {
    console.error("[provision-booking-access] Some devices failed:", failures.map(f => (f as PromiseRejectedResult).reason));
  }

  // Store PIN in booking record
  await admin.from("bookings").update({ access_pin: pin }).eq("id", booking_id);

  // Audit trail
  logAudit(admin, {
    entityType: "booking",
    entityId: booking_id,
    action: "update",
    performedBy: "system",
    changes: {
      access_pin:        { old: null, new: "[provisioned]" },
      devices_activated: { old: [], new: devicesToProvision.map(d => d.label) },
    },
  });

  // ── Format times for messages ────────────────────────────────────────────────
  const fmtTime = (t: string) => {
    const [h, m] = (t as string).split(":").map(Number);
    const suffix = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
  };
  const bookingRef = booking.booking_number as string;
  const startFmt   = fmtTime(booking.start_time as string);
  const endFmt     = fmtTime(booking.end_time as string);

  // ── Resolve contact details ──────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = booking.lead as any;
  const contactPhone = (booking.booker_phone as string | null) ?? (booking.guest_phone as string | null) ?? lead?.phone;
  const contactEmail = (booking.guest_email as string | null) ?? lead?.email;
  const leadFullName = `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim();
  const contactName  = (booking.guest_name as string | null) ?? (leadFullName || "Guest");

  // ── Deliver PIN (best-effort; track per-channel status) ─────────────────────
  const delivery: DeliveryStatus = {
    whatsapp: "skipped",
    sms:      "skipped",
    email:    "skipped",
  };

  if (contactPhone) {
    // WhatsApp — held pending template approval in MSG91 dashboard.
    // Re-enable by uncommenting once "booking_access_pin" template is approved.
    // messaging.bookingAccessPin(contactPhone, contactName, bookingRef, startFmt, endFmt, pin, booking_id)
    delivery.whatsapp = "skipped";

    // DLT SMS OTP — MSG91_SMS_ENABLED=true, flow ID MSG91_SMS_DLT_FLOW_OTP must be set
    const smsResult = await dltSms.otp(contactPhone, pin, booking_id)
      .catch((err) => { console.error("[provision-booking-access] SMS error:", err); return null; });
    if (!smsResult) {
      delivery.sms = "failed";
    } else if (smsResult.error === "SMS disabled") {
      delivery.sms = "disabled";
    } else if (smsResult.success) {
      delivery.sms = "sent";
    } else {
      delivery.sms = "failed";
      console.warn("[provision-booking-access] SMS delivery failed:", smsResult.error);
    }
  } else {
    console.warn("[provision-booking-access] No phone on booking", booking_id, "— SMS skipped.");
  }

  // Email (SMTP primary → Resend fallback)
  if (contactEmail) {
    const emailResult = await resend.emails.send({
      from: EMAIL_FROM,
      to: contactEmail,
      subject: `Your WorkVilla Access PIN — Booking ${bookingRef}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="font-size:20px;font-weight:700;color:#1a1a1a;margin:0 0 16px">Access PIN for Booking ${bookingRef}</h2>
          <p style="margin:0 0 8px;color:#444">Hi ${contactName},</p>
          <p style="margin:0 0 20px;color:#444">Here is your door access PIN for your booking at <strong>The WorkVilla</strong>:</p>
          <div style="background:#f5f5f5;border-radius:8px;padding:24px;text-align:center;margin:0 0 20px">
            <p style="font-size:48px;font-weight:700;letter-spacing:12px;color:#1a1a1a;margin:0;font-family:monospace">${pin}</p>
          </div>
          <table style="width:100%;border-collapse:collapse;margin:0 0 20px">
            <tr><td style="padding:6px 0;color:#888;font-size:13px">Booking</td><td style="padding:6px 0;color:#1a1a1a;font-weight:600;font-size:13px">${bookingRef}</td></tr>
            <tr><td style="padding:6px 0;color:#888;font-size:13px">Date</td><td style="padding:6px 0;color:#1a1a1a;font-size:13px">${bookingDate}</td></tr>
            <tr><td style="padding:6px 0;color:#888;font-size:13px">Time</td><td style="padding:6px 0;color:#1a1a1a;font-size:13px">${startFmt} – ${endFmt}</td></tr>
          </table>
          <p style="margin:0 0 8px;color:#444;font-size:14px">Enter this PIN at the entrance and conference room devices to unlock the door.</p>
          <p style="margin:0;color:#aaa;font-size:12px">The PIN expires automatically 5 minutes after your booking ends.</p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
          <p style="margin:0;color:#888;font-size:12px">— The WorkVilla Team</p>
        </div>
      `,
    }).catch((err) => {
      console.error("[provision-booking-access] Email send error:", err);
      return { data: null, error: { message: String(err), name: "unexpected" } };
    });

    if (emailResult?.error) {
      delivery.email = "failed";
      console.error("[provision-booking-access] Email delivery failed for", booking_id, "→", emailResult.error.message);
    } else {
      delivery.email = "sent";
      console.info("[provision-booking-access] Email delivered to", contactEmail);
    }
  } else {
    console.warn("[provision-booking-access] No email on booking", booking_id, "— email skipped.");
  }

  const failedChannels = Object.entries(delivery)
    .filter(([, s]) => s === "failed")
    .map(([ch]) => ch);
  if (failedChannels.length > 0) {
    console.warn("[provision-booking-access] PIN provisioned but delivery failed on:", failedChannels.join(", "));
  } else {
    console.info("[provision-booking-access] PIN provisioned and delivered for booking", booking_id);
  }

  return { ok: true, pin, devicesProvisioned: devicesToProvision.length, delivery };
}
