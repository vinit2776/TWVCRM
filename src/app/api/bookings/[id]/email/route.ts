import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { generateICS } from "@/lib/ics-generator";
import { BOOKING_CUSTOMER_TYPE_LABELS, BOOKING_PAYMENT_MODE_LABELS, BOOKING_PAYMENT_STATUS_LABELS } from "@/lib/constants";
import { logEmailActivity } from "@/lib/audit";
import { getLocationIncharges, getLocationInchargeUserIds } from "@/lib/location-incharges";
import { sendPushToUsers } from "@/lib/push";
import { bookingWindowHours } from "@/lib/utils";

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0 }).format(amount);
}

// Rounds to 2dp to avoid floating-point noise (e.g. summed duration_hours
// producing 6.699999999999999) leaking into customer-facing emails.
function roundHours(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatDate(dateStr: string): string {
  // Anchor the date in IST so the displayed day matches the booking_date
  // column regardless of the server's local timezone.
  return new Date(dateStr + "T00:00:00+05:30").toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
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

// IST stamp for check-in / check-out times in transactional emails. The
// runtime tz on Vercel is UTC, so toLocaleString with no timeZone option
// sent emails with the wrong (UTC) wall-clock time.
function formatIstStamp(date: Date | string): string {
  return new Date(date).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Get sender info for activity logging
  const { data: sender } = await supabase
    .from("users")
    .select("id, full_name")
    .eq("auth_id", user.id)
    .single();

  const body = await request.json();
  const emailType = body.type || "confirmation"; // "confirmation" | "cleaning" | "check_in_alert" | "feedback_link" | "payment_link"

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
      .select("unifi_code, ruijie_code, voucher:voucher_repository!voucher_issuances_voucher_id_fkey(voucher_code)")
      .eq("booking_id", id)
      .eq("is_active", true)
      .limit(1);
    if (issuances?.[0]) {
      const row = issuances[0] as unknown as { unifi_code?: string | null; ruijie_code?: string | null; voucher?: { voucher_code: string } | null };
      voucherCode = row.voucher?.voucher_code ?? row.unifi_code ?? row.ruijie_code ?? null;
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

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").trim();

  // ── Check-in alert to floor in-charges (CC managers) ──
  if (emailType === "check_in_alert") {
    const { to: inchargeRecipients, cc: managerCc, fellBack } =
      await getLocationIncharges(supabase, booking.location_id);

    if (inchargeRecipients.length === 0 && managerCc.length === 0) {
      return NextResponse.json({ error: "No in-charges or managers configured" }, { status: 400 });
    }

    const alertHtml = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#015E65;padding:20px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:20px;">Customer Checked In</h1>
        </div>
        <div style="padding:20px;">
          <p>A customer has just checked in:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Location</td><td style="padding:8px;border:1px solid #ddd;">${locationName || "—"}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Room</td><td style="padding:8px;border:1px solid #ddd;">${spaceName}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Customer</td><td style="padding:8px;border:1px solid #ddd;">${customerName}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Check-in Time</td><td style="padding:8px;border:1px solid #ddd;">${formatIstStamp(new Date())}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Booking</td><td style="padding:8px;border:1px solid #ddd;">${booking.booking_number}</td></tr>
          </table>
          ${fellBack ? `<p style="color:#b45309;font-size:11px;margin-top:16px;">Note: this location has no designated floor in-charge yet. Set one in Locations → Edit.</p>` : ""}
        </div>
      </div>`;

    const toAddresses = inchargeRecipients.map((u) => u.email);
    const ccAddresses = managerCc.map((u) => u.email);

    if (toAddresses.length > 0) {
      await resend.emails.send({
        from: EMAIL_FROM,
        to: toAddresses,
        cc: ccAddresses.length > 0 ? ccAddresses : undefined,
        subject: `Check-In${locationName ? ` [${locationName}]` : ""}: ${customerName} at ${spaceName} - The WorkVilla`,
        html: alertHtml,
      }).catch((e) => console.error(`Failed to send check-in alert:`, e));
    } else if (ccAddresses.length > 0) {
      await resend.emails.send({
        from: EMAIL_FROM,
        to: ccAddresses,
        subject: `Check-In${locationName ? ` [${locationName}]` : ""}: ${customerName} at ${spaceName} - The WorkVilla`,
        html: alertHtml,
      }).catch((e) => console.error(`Failed to send check-in alert:`, e));
    }

    return NextResponse.json({
      message: "Check-in alert sent",
      to: toAddresses,
      cc: ccAddresses,
      fellBack,
    });
  }

  // ── Feedback link email to customer ──
  if (emailType === "feedback_link") {
    if (!customerEmail) return NextResponse.json({ error: "No customer email available" }, { status: 400 });
    const feedbackUrl = `${appUrl}/feedback/${booking.feedback_token}`;

    const senderName = sender?.full_name || "TWV Team";
    await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: customerEmail,
      subject: `How was your experience? - ${booking.booking_number} - The WorkVilla`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:20px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Empower your business with flexible workspaces</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#1a1b1e;font-size:15px;">Dear ${customerName},</p>
            <p style="color:#333;font-size:14px;">Thank you for choosing The WorkVilla for your recent booking. We hope you had a great experience using our workspace.</p>
            <p style="color:#333;font-size:14px;">Your feedback helps us improve our services and deliver a better experience to you every time. We would greatly appreciate it if you could take a moment to share your thoughts.</p>
            <div style="text-align:center;margin:24px 0;">
              <a href="${feedbackUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">Share Your Feedback</a>
            </div>
            <p style="color:#666;font-size:13px;">Booking: ${booking.booking_number} | Room: ${spaceName}${locationName ? ` | Location: ${locationName}` : ""}</p>
            <p style="color:#333;font-size:14px;margin-top:20px;">Warm regards,<br/><strong>${senderName}</strong><br/>The WorkVilla</p>
            <p style="color:#666;font-size:12px;margin-top:16px;">For any queries, write to us at <a href="mailto:contact@theworkvilla.com" style="color:#015E65;">contact@theworkvilla.com</a> or call <strong>+91 97910 97900</strong>.</p>
          </div>
          <div style="background:#015E65;padding:16px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
            <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:10px;">www.theworkvilla.com</p>
          </div>
        </div>`,
    });

    // Log email activity for the lead
    if (booking.lead_id && sender?.id) {
      logEmailActivity(supabase, {
        leadId: booking.lead_id,
        subject: `Feedback link sent for ${booking.booking_number}`,
        description: `Feedback link for booking ${booking.booking_number} (${spaceName}) emailed to ${customerEmail}`,
        createdBy: sender.id,
      });
    }

    return NextResponse.json({ message: "Feedback link sent" });
  }

  // ── Payment link email to customer ──
  if (emailType === "payment_link") {
    if (!customerEmail) return NextResponse.json({ error: "No customer email available" }, { status: 400 });

    // Use Razorpay payment link URL if provided, otherwise fall back to internal link
    const razorpayPaymentLinkUrl = body.razorpay_payment_link_url || booking.razorpay_payment_link_url;
    const paymentUrl = razorpayPaymentLinkUrl || `${appUrl}/pay/${booking.payment_token}`;
    const isRazorpayLink = !!razorpayPaymentLinkUrl;

    // Calculate balance due for the email
    const { data: verifiedPayments } = await supabase
      .from("booking_payments")
      .select("amount")
      .eq("booking_id", id)
      .eq("status", "verified");
    const totalPaid = (verifiedPayments || []).reduce((s, p) => s + Number(p.amount), 0);
    const balanceDue = Math.max(0, Number(booking.total_amount) - totalPaid);
    const displayAmount = balanceDue > 0 ? balanceDue : Number(booking.total_amount);

    const paymentSenderName = sender?.full_name || "TWV Team";
    await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: customerEmail,
      subject: `Payment Link${locationName ? ` [${locationName}]` : ""} - ${booking.booking_number} - ₹${displayAmount.toLocaleString("en-IN")} - The WorkVilla`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#015E65;padding:20px 32px;">
            <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Empower your business with flexible workspaces</p>
          </div>
          <div style="padding:32px;">
            <p style="color:#1a1b1e;font-size:15px;">Dear ${customerName},</p>
            <p style="color:#333;font-size:14px;">Thank you for your booking at The WorkVilla. Please complete the payment using the link below.</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f0faf5;border-radius:6px;">
              <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Booking</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${booking.booking_number}</td></tr>
              <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Room</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${spaceName}</td></tr>
              ${locationName ? `<tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Location</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${locationName}</td></tr>` : ""}
              <tr><td style="padding:10px 16px;color:#666;">Amount Due</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;">₹${displayAmount.toLocaleString("en-IN")}</td></tr>
            </table>
            <div style="text-align:center;margin:24px 0;">
              <a href="${paymentUrl}" style="background:#015E65;color:white;padding:12px 32px;text-decoration:none;border-radius:8px;font-weight:bold;display:inline-block;">Pay Now</a>
            </div>
            ${isRazorpayLink ? '<p style="color:#666;font-size:13px;text-align:center;">Powered by Razorpay — secure payments via UPI, cards, net banking & more.</p>' : ""}
            <p style="color:#333;font-size:14px;margin-top:20px;">Warm regards,<br/><strong>${paymentSenderName}</strong><br/>The WorkVilla</p>
            <p style="color:#666;font-size:12px;margin-top:16px;">For any queries, write to us at <a href="mailto:contact@theworkvilla.com" style="color:#015E65;">contact@theworkvilla.com</a> or call <strong>+91 97910 97900</strong>.</p>
          </div>
          <div style="background:#015E65;padding:16px 32px;text-align:center;">
            <p style="color:#fff;margin:0;font-size:11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
            <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
            <p style="color:#00AE6C;margin:4px 0 0;font-size:10px;">www.theworkvilla.com</p>
          </div>
        </div>`,
    });

    // Log email activity for the lead
    if (booking.lead_id && sender?.id) {
      logEmailActivity(supabase, {
        leadId: booking.lead_id,
        subject: `Payment link sent for ${booking.booking_number}`,
        description: `Payment link for booking ${booking.booking_number} (${spaceName}, ₹${displayAmount.toLocaleString("en-IN")}) emailed to ${customerEmail}`,
        createdBy: sender.id,
      });
    }

    return NextResponse.json({ message: "Payment link sent" });
  }

  if (emailType === "cleaning") {
    // Recipients are now scoped to the booking's location:
    //   To: the location's designated floor in-charges (max 2)
    //   CC: managers (supervisory only — they can stay informed but the
    //       primary action sits with the in-charges)
    //   admin role intentionally dropped — historic noise.
    // Push notifications go to the same set so in-charges using the mobile
    // PWA get the alert without checking email.
    const { to: inchargeRecipients, cc: managerCc, fellBack } =
      await getLocationIncharges(supabase, booking.location_id);

    if (inchargeRecipients.length === 0 && managerCc.length === 0) {
      return NextResponse.json({ error: "No in-charges or managers configured" }, { status: 400 });
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
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Check-out Time</td><td style="padding:8px;border:1px solid #ddd;">${booking.check_out_at ? formatIstStamp(booking.check_out_at) : "N/A"}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Booking</td><td style="padding:8px;border:1px solid #ddd;">${booking.booking_number}</td></tr>
          </table>
          <p style="color:#666;">Please arrange cleaning for the room at the earliest.</p>
          ${fellBack ? `<p style="color:#b45309;font-size:11px;margin-top:16px;">Note: this location has no designated floor in-charge yet. Set one in Locations → Edit so future alerts route directly to the right person.</p>` : ""}
        </div>
      </div>`;

    // Single Resend call with To + CC — Resend natively supports both.
    const toAddresses = inchargeRecipients.map((u) => u.email);
    const ccAddresses = managerCc.map((u) => u.email);

    if (toAddresses.length > 0) {
      await resend.emails.send({
        from: EMAIL_FROM,
        to: toAddresses,
        cc: ccAddresses.length > 0 ? ccAddresses : undefined,
        subject: `Cleaning Required${locationName ? ` [${locationName}]` : ""} - ${spaceName} - The WorkVilla`,
        html: cleaningHtml,
      }).catch((e) => console.error(`Failed to send cleaning email:`, e));
    } else if (ccAddresses.length > 0) {
      // No in-charges — send to managers as the primary recipients.
      await resend.emails.send({
        from: EMAIL_FROM,
        to: ccAddresses,
        subject: `Cleaning Required${locationName ? ` [${locationName}]` : ""} - ${spaceName} - The WorkVilla`,
        html: cleaningHtml,
      }).catch((e) => console.error(`Failed to send cleaning email:`, e));
    }

    // Fire push notifications to the same audience so the in-charges using
    // the mobile PWA get the alert without checking email.
    const { primary, supervisory } = await getLocationInchargeUserIds(supabase, booking.location_id);
    sendPushToUsers([...primary, ...supervisory], {
      title: `🧹 Cleaning Required${locationName ? ` — ${locationName}` : ""}`,
      body: `${spaceName} just checked out (${booking.booking_number}). Arrange cleaning.`,
      url: `/bookings/${booking.booking_number || booking.id}`,
      tag: `cleaning-${booking.id}`,
    }).catch((e) => console.error("[cleaning push] failed:", e));

    return NextResponse.json({
      message: `Cleaning alert sent`,
      to: toAddresses,
      cc: ccAddresses,
      fellBack,
    });
  }

  // Confirmation email
  if (!customerEmail) {
    return NextResponse.json({ error: "No customer email available" }, { status: 400 });
  }

  const startTime = formatTime(booking.start_time.slice(0, 5));
  const endTime = formatTime(booking.end_time.slice(0, 5));
  // Customer-facing duration display must use the actual booking window, not
  // booking.duration_hours — for daily-priced spaces that column stores "1"
  // as a billing quantity (one day unit), not one hour, and would render a
  // 10-hour day pass as "Duration: 1 hour(s)". The free-quota deduction below
  // still uses duration_hours on purpose — do not change that one.
  const displayDurationHours = roundHours(bookingWindowHours(booking.start_time, booking.end_time));

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
    description: `Booking: ${booking.booking_number}\nRoom: ${spaceName}\nDuration: ${displayDurationHours}hrs\nAmount: ${formatCurrency(booking.total_amount)}`,
    location: `${spaceName}, ${locationName}${locationAddress ? ", " + locationAddress : ""}`,
    startDate: startUTC,
    endDate: endUTC,
    organizerEmail: "noreply@theworkvilla.com",
    attendeeEmail: customerEmail,
  });

  const icsBase64 = Buffer.from(icsContent).toString("base64");

  // ── Payment block ──────────────────────────────────────────────────────────
  // Surface the current payment state so the customer can see at-a-glance what
  // they've already paid (and via which method / reference). Walk-in and guest
  // bookings collect payment up-front; contract holders are usually post-paid.
  // If a UPI confirmation screenshot was uploaded, attach it inline so the
  // customer has the original proof in their inbox forever.
  const { data: payments } = await supabase
    .from("booking_payments")
    .select("id, amount, payment_mode, payment_reference, status, screenshot_path, created_at")
    .eq("booking_id", id)
    .order("created_at", { ascending: true });

  const verifiedPayments = (payments ?? []).filter((p) => p.status === "verified");
  const pendingPayments  = (payments ?? []).filter((p) => p.status === "pending");
  const totalPaid = verifiedPayments.reduce((s, p) => s + Number(p.amount), 0);
  const totalDue  = Number(booking.total_amount_with_gst ?? booking.total_amount ?? 0);
  const balanceDue = Math.max(0, totalDue - totalPaid);
  const isFullyPaid = totalPaid >= totalDue && totalDue > 0;

  // Pull screenshot attachments for any verified UPI payment so the customer's
  // proof of payment travels with the email itself.
  const paymentAttachments: { filename: string; content: string; contentType: string }[] = [];
  for (const p of verifiedPayments) {
    if (!p.screenshot_path) continue;
    try {
      const { data: file } = await supabase.storage
        .from("crm-documents")
        .download(p.screenshot_path);
      if (!file) continue;
      const buf = Buffer.from(await file.arrayBuffer());
      // Derive extension/mime from the stored path; default to jpg.
      const ext = (p.screenshot_path.split(".").pop() || "jpg").toLowerCase();
      const mime =
        ext === "png"  ? "image/png"  :
        ext === "pdf"  ? "application/pdf" :
        ext === "webp" ? "image/webp" :
                         "image/jpeg";
      paymentAttachments.push({
        filename: `payment-proof-${booking.booking_number}.${ext}`,
        content: buf.toString("base64"),
        contentType: mime,
      });
    } catch {
      // Non-fatal: missing file shouldn't block the confirmation email.
    }
  }

  function paymentRowHtml(p: { amount: number; payment_mode: string; payment_reference: string | null; status: string; screenshot_path: string | null }): string {
    const modeLabel = BOOKING_PAYMENT_MODE_LABELS[p.payment_mode] || p.payment_mode;
    const statusPill = p.status === "verified"
      ? `<span style="display:inline-block;background:#dcfce7;color:#166534;font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.4px;">Received</span>`
      : `<span style="display:inline-block;background:#fef3c7;color:#92400e;font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.4px;">Pending</span>`;
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${modeLabel}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;color:#666;">${p.payment_reference || "—"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${statusPill}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;">${formatCurrency(Number(p.amount))}</td>
    </tr>`;
  }

  const paymentSection = (() => {
    if (!payments || payments.length === 0) {
      // No payment recorded yet — most likely a contract holder being post-billed.
      // Still useful to show a payment status row.
      const isPostPaid = booking.customer_type === "contract_holder";
      const bg     = isPostPaid ? "#eff6ff" : "#fef3c7";
      const border = isPostPaid ? "#3b82f6" : "#f59e0b";
      const color  = isPostPaid ? "#1e40af" : "#92400e";
      const label  = isPostPaid
        ? "This booking will be added to your monthly invoice."
        : "Payment is pending. We'll update you once received.";
      return `<div style="background:${bg};border:1px solid ${border};border-radius:8px;padding:14px 16px;margin:16px 0;">
        <p style="margin:0;color:${color};font-size:13px;font-weight:600;">Payment Status</p>
        <p style="margin:4px 0 0;color:${color};font-size:12px;">${label}</p>
      </div>`;
    }

    const headerColor    = isFullyPaid ? "#15803d" : "#b45309";
    const headerBg       = isFullyPaid ? "#f0fdf4" : "#fffbeb";
    const headerBorder   = isFullyPaid ? "#22c55e" : "#f59e0b";
    const headerLabel    = isFullyPaid ? "Payment Received in Full" : "Payment In Progress";

    return `<div style="background:${headerBg};border:1px solid ${headerBorder};border-radius:8px;padding:16px;margin:16px 0;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <span style="color:${headerColor};font-size:14px;font-weight:700;">${headerLabel}</span>
        <span style="color:${headerColor};font-size:13px;font-weight:600;">${formatCurrency(totalPaid)} of ${formatCurrency(totalDue)}</span>
      </div>
      ${balanceDue > 0 ? `<p style="margin:0 0 10px;color:#b45309;font-size:12px;">Balance due: <strong>${formatCurrency(balanceDue)}</strong></p>` : ""}
      <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;margin-top:8px;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid #e5e7eb;">Method</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid #e5e7eb;">Reference</th>
            <th style="padding:8px 12px;text-align:center;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid #e5e7eb;">Status</th>
            <th style="padding:8px 12px;text-align:right;font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid #e5e7eb;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${[...verifiedPayments, ...pendingPayments].map(paymentRowHtml).join("")}
        </tbody>
      </table>
      ${paymentAttachments.length > 0 ? `<p style="margin:10px 0 0;font-size:11px;color:${headerColor};">📎 Payment confirmation${paymentAttachments.length > 1 ? "s" : ""} attached for your records.</p>` : ""}
    </div>`;
  })();

  // Voucher section for walk-in/guest
  const voucherSection = voucherCode
    ? `<div style="background:#f0fdf4;border:1px solid #00AE6C;border-radius:8px;padding:16px;margin:16px 0;text-align:center;">
        <p style="margin:0 0 8px;color:#015E65;font-weight:bold;">Your WiFi Voucher Code</p>
        <p style="margin:0;font-size:28px;font-family:monospace;letter-spacing:4px;color:#015E65;font-weight:bold;">${voucherCode}</p>
        <p style="margin:8px 0 0;font-size:12px;color:#666;">Connect to "The WorkVilla" WiFi network and enter this code. Valid for 24 hours.</p>
      </div>`
    : "";

  // ── Contract quota section (contract_holder only) ────────────────────────
  let quotaSection = "";
  if (booking.customer_type === "contract_holder" && booking.contract_id) {
    const { data: facility } = await supabase
      .from("contract_facilities")
      .select("name, free_quota, unit")
      .eq("contract_id", booking.contract_id)
      .in("unit", ["hr", "hrs", "hour", "hours", "h"])
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();

    if (facility && Number(facility.free_quota) > 0) {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
      const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
      const monthLabel = now.toLocaleString("en-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

      // Sum hours used by this contract this calendar month, excluding the current booking
      const { data: monthBookings } = await supabase
        .from("bookings")
        .select("duration_hours")
        .eq("contract_id", booking.contract_id)
        .neq("id", id)
        .in("status", ["confirmed", "checked_in", "checked_out"])
        .gte("booking_date", monthStart)
        .lte("booking_date", monthEnd);

      const usedBefore      = roundHours((monthBookings ?? []).reduce((s, b) => s + Number(b.duration_hours), 0));
      const usedThisBooking = roundHours(Number(booking.duration_hours));
      const usedAfter       = roundHours(usedBefore + usedThisBooking);
      const monthlyQuota    = roundHours(Number(facility.free_quota));
      const balanceAfter    = roundHours(Math.max(0, monthlyQuota - usedAfter));
      const overage         = roundHours(Math.max(0, usedAfter - monthlyQuota));

      const balanceColor  = balanceAfter === 0 ? "#b45309" : "#15803d";
      const balanceBg     = balanceAfter === 0 ? "#fffbeb" : "#f0fdf4";
      const balanceBorder = balanceAfter === 0 ? "#f59e0b" : "#22c55e";
      const overageNote   = overage > 0
        ? `<p style="margin:8px 0 0;color:#b45309;font-size:12px;">⚠️ ${overage} hr${overage !== 1 ? "s" : ""} exceed${overage === 1 ? "s" : ""} your free quota and will be billed at your contract rate.</p>`
        : "";

      quotaSection = `
        <div style="background:${balanceBg};border:1px solid ${balanceBorder};border-radius:8px;padding:16px;margin:16px 0;">
          <p style="margin:0 0 10px;color:${balanceColor};font-size:14px;font-weight:700;">Meeting Room Hours — ${monthLabel}</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <tr>
              <td style="padding:6px 0;color:#6b7280;">Monthly quota</td>
              <td style="padding:6px 0;text-align:right;font-weight:600;">${monthlyQuota} hr${monthlyQuota !== 1 ? "s" : ""}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#6b7280;border-top:1px solid #e5e7eb;">Used this month (before this booking)</td>
              <td style="padding:6px 0;text-align:right;border-top:1px solid #e5e7eb;">${usedBefore} hr${usedBefore !== 1 ? "s" : ""}</td>
            </tr>
            <tr>
              <td style="padding:6px 0;color:#6b7280;">This booking</td>
              <td style="padding:6px 0;text-align:right;">${usedThisBooking} hr${usedThisBooking !== 1 ? "s" : ""}</td>
            </tr>
            <tr style="border-top:2px solid ${balanceBorder};">
              <td style="padding:8px 0 4px;font-weight:700;color:${balanceColor};">Balance remaining</td>
              <td style="padding:8px 0 4px;text-align:right;font-weight:700;color:${balanceColor};">${balanceAfter} hr${balanceAfter !== 1 ? "s" : ""}</td>
            </tr>
          </table>
          ${overageNote}
        </div>`;
    }
  }

  const confirmSenderName = sender?.full_name || "TWV Team";
  const confirmationHtml = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:20px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Empower your business with flexible workspaces</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#1a1b1e;font-size:15px;">Dear ${customerName},</p>
        <p style="color:#333;font-size:14px;">Thank you for choosing The WorkVilla! Your meeting room booking has been confirmed. Here are the details:</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;background:#f0faf5;border-radius:6px;">
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;width:40%;">Booking #</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;border-bottom:1px solid #e5e7eb;">${booking.booking_number}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Room</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${spaceName}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Location</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${locationName}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Date</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${formatDate(booking.booking_date)}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Time</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${startTime} - ${endTime}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Duration</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${displayDurationHours} hour(s)</td></tr>
          ${facilityList ? `<tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Facilities</td><td style="padding:10px 16px;color:#333;border-bottom:1px solid #e5e7eb;">${facilityList}</td></tr>` : ""}
          <tr><td style="padding:10px 16px;color:#666;border-bottom:1px solid #e5e7eb;">Amount</td><td style="padding:10px 16px;font-weight:bold;color:#015E65;border-bottom:1px solid #e5e7eb;">${formatCurrency(booking.total_amount)}</td></tr>
          <tr><td style="padding:10px 16px;color:#666;">Customer Type</td><td style="padding:10px 16px;color:#333;">${BOOKING_CUSTOMER_TYPE_LABELS[booking.customer_type] || booking.customer_type}</td></tr>
        </table>
        ${paymentSection}
        ${voucherSection}
        ${quotaSection}
        <p style="color:#333;font-size:14px;">Please arrive 5 minutes before your scheduled time. A calendar invite (.ics) is attached for your convenience.</p>
        <p style="color:#333;font-size:14px;">We look forward to hosting you!</p>
        <p style="color:#333;font-size:14px;">Warm regards,<br/><strong>${confirmSenderName}</strong><br/>The WorkVilla</p>
        <p style="color:#666;font-size:12px;margin-top:16px;">For any queries, write to us at <a href="mailto:contact@theworkvilla.com" style="color:#015E65;">contact@theworkvilla.com</a> or call <strong>+91 97910 97900</strong>.</p>
      </div>
      <div style="background:#015E65;padding:16px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
        <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:10px;">www.theworkvilla.com</p>
      </div>
    </div>`;

  // Fetch internal team once — used for BCC on customer email + grouped notification.
  const { data: managers } = await supabase
    .from("users")
    .select("email, full_name")
    .in("role", ["admin", "manager", "floor_manager"])
    .eq("is_active", true);

  const internalBcc = (managers ?? [])
    .map((m) => m.email)
    .filter((e): e is string => !!e && e !== customerEmail);

  // ── Customer confirmation (To: customer, BCC: internal team) ──────────────
  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      to: customerEmail,
      bcc: internalBcc.length > 0 ? internalBcc : undefined,
      subject: `Booking Confirmation - ${booking.booking_number} - The WorkVilla`,
      html: confirmationHtml,
      attachments: [
        {
          filename: `${booking.booking_number}.ics`,
          content: icsBase64,
          contentType: "text/calendar",
        },
        // Payment confirmation screenshots (one per verified UPI payment),
        // base64-encoded by the loop above. Empty array if none uploaded.
        ...paymentAttachments,
      ],
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: `Failed to send confirmation email: ${msg}` }, { status: 500 });
  }

  // Log email activity for the lead
  if (booking.lead_id && sender?.id) {
    logEmailActivity(supabase, {
      leadId: booking.lead_id,
      subject: `Booking confirmation sent for ${booking.booking_number}`,
      description: `Booking confirmation for ${booking.booking_number} (${spaceName}, ${formatDate(booking.booking_date)} ${startTime}–${endTime}) emailed to ${customerEmail}`,
      createdBy: sender.id,
    });
  }

  // ── Internal team notification (single grouped email To: all staff) ───────
  // Separate from the customer email so staff see the internal context
  // (notes, phone, payment status, prep reminder) that the customer doesn't.
  if (managers && managers.length > 0) {
    const managerEmails = managers.map((m) => m.email).filter((e): e is string => !!e);

    const managerHtml = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#015E65;padding:20px;text-align:center;">
          <h1 style="color:white;margin:0;font-size:20px;">New Room Booking</h1>
        </div>
        <div style="padding:20px;">
          <p>A new meeting room booking has been created:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Booking #</td><td style="padding:8px;border:1px solid #ddd;">${booking.booking_number}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Location</td><td style="padding:8px;border:1px solid #ddd;">${locationName || "—"}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Room</td><td style="padding:8px;border:1px solid #ddd;">${spaceName}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Date & Time</td><td style="padding:8px;border:1px solid #ddd;">${formatDate(booking.booking_date)} ${startTime} - ${endTime}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Customer</td><td style="padding:8px;border:1px solid #ddd;">${customerName} (${BOOKING_CUSTOMER_TYPE_LABELS[booking.customer_type]})</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Contact</td><td style="padding:8px;border:1px solid #ddd;">${customerEmail || "N/A"} / ${booking.lead?.phone || booking.guest_phone || "N/A"}</td></tr>
            ${facilityList ? `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Facilities</td><td style="padding:8px;border:1px solid #ddd;">${facilityList}</td></tr>` : ""}
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Amount</td><td style="padding:8px;border:1px solid #ddd;">${formatCurrency(booking.total_amount)}</td></tr>
            <tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Payment Status</td><td style="padding:8px;border:1px solid #ddd;">${BOOKING_PAYMENT_STATUS_LABELS[booking.payment_status] || booking.payment_status || "—"}</td></tr>
            ${booking.notes ? `<tr><td style="padding:8px;border:1px solid #ddd;font-weight:bold;">Notes</td><td style="padding:8px;border:1px solid #ddd;">${booking.notes}</td></tr>` : ""}
          </table>
          <p style="color:#015E65;font-weight:bold;">Please ensure the room is prepared before ${startTime}.</p>
        </div>
      </div>`;

    resend.emails.send({
      from: EMAIL_FROM,
      to: managerEmails,
      subject: `New Booking${locationName ? ` [${locationName}]` : ""}: ${spaceName} - ${formatDate(booking.booking_date)} ${startTime} - ${booking.booking_number}`,
      html: managerHtml,
    }).catch((e) => console.error("Failed to send internal booking notification:", e));
  }

  return NextResponse.json({ message: "Confirmation email sent" });
}
