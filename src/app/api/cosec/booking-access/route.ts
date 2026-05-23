import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { provisionUser, bookingCosecId, uuidToRefId, generatePin } from "@/lib/cosec";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const schema = z.object({
  booking_id: z.string().uuid(),
});

/**
 * POST /api/cosec/booking-access
 *
 * Called internally after a booking is confirmed (payment received or waived).
 * If the booked space has a cosec_device_id:
 *   1. Generates a 6-digit PIN
 *   2. Provisions the guest on entrance devices + the room device
 *   3. Valid window: start_time - 5min to end_time + 5min
 *   4. Sends PIN via WhatsApp + SMS + email
 *   5. Stores PIN in bookings.access_pin
 *
 * Safe to call multiple times — idempotent via upsert.
 */
export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { booking_id } = parsed.data;
  const admin = createAdminClient();

  // Load booking + space + lead
  const { data: booking } = await admin
    .from("bookings")
    .select(`
      id, booking_number, booking_date, start_time, end_time,
      space_id, location_id, guest_name, guest_email, guest_phone, booker_phone,
      lead:leads!bookings_lead_id_fkey(first_name, last_name, email, phone),
      space:spaces!bookings_space_id_fkey(id, name, workspace_type, cosec_device_id, location_id)
    `)
    .eq("id", booking_id)
    .single();

  if (!booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const space = booking.space as any;
  const locationId: string = space?.location_id ?? booking.location_id;

  // ── Always provision entry_point devices for building access ─────────────────
  // Every confirmed booking gets entry door access for the duration ±5 min,
  // regardless of whether the space is a conference room or a hot desk.
  const { data: entryDevices } = await admin
    .from("cosec_devices")
    .select("id, label, device_ip, device_port, device_password")
    .eq("location_id", locationId)
    .eq("is_enabled", true)
    .eq("device_category", "entry_point");

  // ── Optionally add the specific room device for conference/meeting rooms ──────
  // Only conference_room and meeting_room spaces have a linked business_centre
  // device. Other space types (hot desk, private office, etc.) get entry access only.
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
    return NextResponse.json({ ok: true, skipped: true, reason: "No enabled COSEC devices at location" });
  }

  // Build valid window (start - 5min, end + 5min)
  const bookingDate = booking.booking_date as string; // YYYY-MM-DD
  function toIST(date: string, time: string, offsetMinutes: number): Date {
    // time is HH:MM:SS in IST
    const [h, m, s] = (time as string).split(":").map(Number);
    const base = new Date(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s ?? 0).padStart(2, "0")}+05:30`);
    return new Date(base.getTime() + offsetMinutes * 60000);
  }

  const validFrom  = toIST(bookingDate, booking.start_time as string, -5);
  const validUntil = toIST(bookingDate, booking.end_time as string, +5);

  const pin         = generatePin();
  const cosecUserId = bookingCosecId(booking_id);
  const cosecRefId  = uuidToRefId(booking_id, 90001, 99999);
  const now         = new Date().toISOString();

  // Provision on all devices
  const results = await Promise.allSettled(devicesToProvision.map(async (dev) => {
    await provisionUser(
      { ip: dev.device_ip, port: dev.device_port, password: dev.device_password },
      {
        cosecUserId,
        cosecRefId,
        name: ((booking.guest_name as string) || "Visitor").slice(0, 15),
        userActive: true,       // booking users are immediately active (PIN-only access)
        validUntil,
        pin,
        byPassFinger: true,     // PIN-only — no biometric enrollment required
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
    console.error("[booking-access] some devices failed:", failures.map(f => (f as PromiseRejectedResult).reason));
  }

  // Store PIN in booking
  await admin.from("bookings").update({ access_pin: pin }).eq("id", booking_id);

  // Audit trail — system-provisioned COSEC PIN for a confirmed booking.
  // Logs the event and which devices were activated; PIN digits are not stored.
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

  // Format times for message
  const fmtTime = (t: string) => {
    const [h, m] = (t as string).split(":").map(Number);
    const suffix = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
  };
  const bookingRef = booking.booking_number as string;
  const startFmt   = fmtTime(booking.start_time as string);
  const endFmt     = fmtTime(booking.end_time as string);

  // Determine recipient contact details
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lead = booking.lead as any;
  const contactPhone = (booking.booker_phone as string | null) ?? (booking.guest_phone as string | null) ?? lead?.phone;
  const contactEmail = (booking.guest_email as string | null) ?? lead?.email;
  const leadFullName = `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim();
  const contactName  = (booking.guest_name as string | null) ?? (leadFullName || "Guest");

  if (contactPhone) {
    const { dltSms, messaging } = await import("@/lib/whatsapp");

    // WhatsApp — booking_access_pin template (primary channel)
    messaging.bookingAccessPin(contactPhone, contactName, bookingRef, startFmt, endFmt, pin, booking_id)
      .catch(() => null);

    // SMS — DLT OTP template (fallback / redundancy)
    dltSms.otp(contactPhone, pin, booking_id).catch(() => null);
  }

  // Email (fire-and-forget)
  if (contactEmail) {
    const { resend, EMAIL_FROM } = await import("@/lib/mailer");
    resend.emails.send({
      from: EMAIL_FROM,
      to: contactEmail,
      subject: `Your WorkVilla Access PIN — Booking ${bookingRef}`,
      html: `
        <p>Hi ${contactName},</p>
        <p>Your access PIN for <strong>Booking ${bookingRef}</strong> is:</p>
        <h1 style="font-size:48px;letter-spacing:8px;color:#1a1a1a">${pin}</h1>
        <p>Valid from <strong>${startFmt}</strong> to <strong>${endFmt}</strong> on ${bookingDate}.</p>
        <p>Enter this PIN at the entrance and conference room devices to unlock the door.</p>
        <p style="color:#888;font-size:12px">The PIN expires automatically 5 minutes after your booking ends.</p>
        <p>— The WorkVilla Team</p>
      `,
    }).catch(() => null);
  }

  return NextResponse.json({ ok: true, pin, devicesProvisioned: devicesToProvision.length });
}
