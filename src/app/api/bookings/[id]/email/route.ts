import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM } from "@/lib/resend";
import { generateICS } from "@/lib/ics-generator";
import { BOOKING_CUSTOMER_TYPE_LABELS } from "@/lib/constants";

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0 }).format(amount);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatTime(timeStr: string): string {
  const [h, m] = timeStr.split(":");
  const hour = parseInt(h);
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${m} ${ampm}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const emailType = body.type || "confirmation"; // "confirmation" | "cleaning"

  // Fetch booking with all joins
  const { data: booking, error } = await supabase
    .from("bookings")
    .select("*, space:spaces!bookings_space_id_fkey(id, name, capacity, hourly_rate, location_id), location:locations!bookings_location_id_fkey(id, name, code, address, city, state), contract:contracts!bookings_contract_id_fkey(id, contract_number), lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company, email, phone), facilities:booking_facilities(*)")
    .eq("id", id)
    .single();

  if (error || !booking) {
    return NextResponse.json({ error: "Booking not found" }, { status: 404 });
  }

  // Fetch voucher if applicable
  let voucherCode: string | null = null;
  if (booking.customer_type === "walk_in" || booking.customer_type === "guest") {
    const { data: issuances } = await supabase
      .from("voucher_issuances")
      .select("voucher:voucher_repository!voucher_issuances_voucher_id_fkey(voucher_code)")
      .eq("booking_id", id)
      .eq("is_active", true)
      .limit(1);
    if (issuances?.[0]?.voucher) {
      const v = issuances[0].voucher as unknown as { voucher_code: string };
      voucherCode = v.voucher_code;
    }
  }

  const customerName = booking.lead
    ? `${booking.lead.first_name} ${booking.lead.last_name}`
    : booking.guest_name || "Guest";
  const customerEmail = booking.lead?.email || booking.guest_email;
  const spaceName = booking.space?.name || "Conference Room";
  const locationName = booking.location?.name || "";
  const locationAddress = [booking.location?.address, booking.location?.city, booking.location?.state].filter(Boolean).join(", ");
  const facilityList = (booking.facilities || []).map((f: { facility_name: string }) => f.facility_name).join(", ");

  if (emailType === "cleaning") {
    // Send cleaning alert to floor managers
    const { data: managers } = await supabase
      .from("users")
      .select("email, full_name")
      .in("role", ["admin", "manager", "floor_manager"])
      .eq("is_active", true);

    if (!managers || managers.length === 0) {
      return NextResponse.json({ error: "No floor managers found" }, { status: 400 });
    }

    const cleaningHtml = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#015E65;padding:20px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:20px;">Cleaning Required</h1>
        </div>
        <div style="padding:20px;">
          <p>A guest has checked out. Please arrange cleaning for:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Room</td><td style="padding:8px;border:1px solid #ddd;">${spaceName}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Location</td><td style="padding:8px;border:1px solid #ddd;">${locationName}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Check-out Time</td><td style="padding:8px;border:1px solid #ddd;">${booking.check_out_at ? new Date(booking.check_out_at).toLocaleString("en-IN") : "N/A"}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Booking</td><td style="padding:8px;border:1px solid #ddd;">${booking.booking_number}</td></tr>
          </table>
          <p style="color:#666;">Please arrange cleaning for the room at the earliest.</p>
        </div>
      </div>`;

    for (const mgr of managers) {
      try {
        await resend.emails.send({
          from: EMAIL_FROM,
          to: mgr.email,
          subject: `Cleaning Required - ${spaceName} - The WorkVilla`,
          html: cleaningHtml,
        });
      } catch (e) {
        console.error(`Failed to send cleaning email to ${mgr.email}:`, e);
      }
    }

    return NextResponse.json({ message: `Cleaning alert sent to ${managers.length} manager(s)` });
  }

  // Confirmation email
  if (!customerEmail) {
    return NextResponse.json({ error: "No customer email available" }, { status: 400 });
  }

  const startTime = formatTime(booking.start_time.slice(0, 5));
  const endTime = formatTime(booking.end_time.slice(0, 5));

  // Build ICS
  const bookingDateObj = new Date(booking.booking_date + "T00:00:00");
  const [sh, sm] = booking.start_time.split(":").map(Number);
  const [eh, em] = booking.end_time.split(":").map(Number);
  const startDate = new Date(bookingDateObj);
  startDate.setHours(sh, sm, 0, 0);
  // Convert to UTC for ICS (IST = UTC+5:30)
  const startUTC = new Date(startDate.getTime() - 5.5 * 60 * 60 * 1000);
  const endDate = new Date(bookingDateObj);
  endDate.setHours(eh, em, 0, 0);
  const endUTC = new Date(endDate.getTime() - 5.5 * 60 * 60 * 1000);

  const icsContent = generateICS({
    summary: `Meeting Room: ${spaceName} - The WorkVilla`,
    description: `Booking: ${booking.booking_number}\nRoom: ${spaceName}\nDuration: ${booking.duration_hours}hrs\nAmount: ${formatCurrency(booking.total_amount)}`,
    location: `${spaceName}, ${locationName}${locationAddress ? ", " + locationAddress : ""}`,
    startDate: startUTC,
    endDate: endUTC,
    organizerEmail: "noreply@theworkvilla.com",
    attendeeEmail: customerEmail,
  });

  const icsBase64 = Buffer.from(icsContent).toString("base64");

  // Voucher section for walk-in/guest
  const voucherSection = voucherCode
    ? `<div style="background:#f0fdf4;border:1px solid #00AE6C;border-radius:8px;padding:16px;margin:16px 0;text-align:center;">
        <p style="margin:0 0 8px;color:#015E65;font-weight:bold;">Your WiFi Voucher Code</p>
        <p style="margin:0;font-size:28px;font-family:monospace;letter-spacing:4px;color:#015E65;font-weight:bold;">${voucherCode}</p>
        <p style="margin:8px 0 0;font-size:12px;color:#666;">Connect to "The WorkVilla" WiFi network and enter this code. Valid for 24 hours.</p>
      </div>`
    : "";

  const confirmationHtml = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#015E65;padding:20px;text-align:center;">
        <h1 style="color:white;margin:0;font-size:20px;">Booking Confirmation</h1>
      </div>
      <div style="padding:20px;">
        <p>Dear ${customerName},</p>
        <p>Your meeting room booking has been confirmed. Here are the details:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;width:40%;">Booking #</td><td style="padding:8px;border:1px solid #ddd;">${booking.booking_number}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Room</td><td style="padding:8px;border:1px solid #ddd;">${spaceName}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Location</td><td style="padding:8px;border:1px solid #ddd;">${locationName}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Date</td><td style="padding:8px;border:1px solid #ddd;">${formatDate(booking.booking_date)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Time</td><td style="padding:8px;border:1px solid #ddd;">${startTime} - ${endTime}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Duration</td><td style="padding:8px;border:1px solid #ddd;">${booking.duration_hours} hour(s)</td></tr>
          ${facilityList ? `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Facilities</td><td style="padding:8px;border:1px solid #ddd;">${facilityList}</td></tr>` : ""}
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Amount</td><td style="padding:8px;border:1px solid #ddd;">${formatCurrency(booking.total_amount)}</td></tr>
          <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Customer Type</td><td style="padding:8px;border:1px solid #ddd;">${BOOKING_CUSTOMER_TYPE_LABELS[booking.customer_type] || booking.customer_type}</td></tr>
        </table>
        ${voucherSection}
        <p style="color:#666;font-size:14px;">Please arrive 5 minutes before your scheduled time.</p>
        <hr style="margin:20px 0;border:none;border-top:1px solid #eee;" />
        <p style="color:#999;font-size:12px;text-align:center;">The WorkVilla | Prakash Presidium, 110 MG Road, Nungambakkam, Chennai 600034</p>
      </div>
    </div>`;

  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: customerEmail,
      subject: `Booking Confirmation - ${booking.booking_number} - The WorkVilla`,
      html: confirmationHtml,
      attachments: [
        {
          filename: `${booking.booking_number}.ics`,
          content: icsBase64,
          contentType: "text/calendar",
        },
      ],
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: `Failed to send confirmation email: ${msg}` }, { status: 500 });
  }

  // Also notify floor managers
  const { data: managers } = await supabase
    .from("users")
    .select("email, full_name")
    .in("role", ["admin", "manager", "floor_manager"])
    .eq("is_active", true);

  if (managers && managers.length > 0) {
    const managerHtml = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#015E65;padding:20px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:20px;">New Room Booking</h1>
        </div>
        <div style="padding:20px;">
          <p>A new meeting room booking has been created:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Booking #</td><td style="padding:8px;border:1px solid #ddd;">${booking.booking_number}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Room</td><td style="padding:8px;border:1px solid #ddd;">${spaceName}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Date & Time</td><td style="padding:8px;border:1px solid #ddd;">${formatDate(booking.booking_date)} ${startTime} - ${endTime}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Customer</td><td style="padding:8px;border:1px solid #ddd;">${customerName} (${BOOKING_CUSTOMER_TYPE_LABELS[booking.customer_type]})</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Contact</td><td style="padding:8px;border:1px solid #ddd;">${customerEmail || "N/A"} / ${booking.lead?.phone || booking.guest_phone || "N/A"}</td></tr>
            ${facilityList ? `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Facilities</td><td style="padding:8px;border:1px solid #ddd;">${facilityList}</td></tr>` : ""}
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Amount</td><td style="padding:8px;border:1px solid #ddd;">${formatCurrency(booking.total_amount)}</td></tr>
            ${booking.notes ? `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Notes</td><td style="padding:8px;border:1px solid #ddd;">${booking.notes}</td></tr>` : ""}
          </table>
          <p style="color:#015E65;font-weight:bold;">Please ensure the room is prepared before ${startTime}.</p>
        </div>
      </div>`;

    for (const mgr of managers) {
      try {
        await resend.emails.send({
          from: EMAIL_FROM,
          to: mgr.email,
          subject: `New Booking: ${spaceName} - ${formatDate(booking.booking_date)} ${startTime} - ${booking.booking_number}`,
          html: managerHtml,
        });
      } catch (e) {
        console.error(`Failed to send manager notification to ${mgr.email}:`, e);
      }
    }
  }

  return NextResponse.json({ message: "Confirmation email sent" });
}
