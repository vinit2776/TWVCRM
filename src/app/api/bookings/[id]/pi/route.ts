import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { upsertBookingPiStatement } from "@/lib/booking-pi-statement-server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { logAudit } from "@/lib/audit";
import { BOOKING_PI_NOTES, buildBookingPi, bookingPiNumber, piBalanceDue } from "@/lib/booking-pi";
import { generateBookingPiPdf, type BookingPiPdfInput } from "@/lib/booking-pi-pdf";
import { formatCurrency } from "@/lib/utils";
import { validateRecipients } from "@/lib/email-recipients";
import { bookingContactEmail } from "@/lib/booking-contact";

export const dynamic = "force-dynamic";

const PI_ROLES = ["admin", "manager", "floor_manager", "sales_rep", "accounts", "fms", "office_admin", "coordinator"];

// A PI asks for money, so it only makes sense while something is still owed on
// a booking that is going ahead.
const PI_BLOCKED_STATUSES = ["cancelled", "no_show", "checked_out"];
const PI_BLOCKED_PAYMENT_STATUSES = ["paid", "waived", "prepaid", "posted_to_bill"];

type Loaded =
  | { ok: false; response: NextResponse }
  | {
      ok: true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- joined row; same any-client treatment as the email route
      booking: any;
      input: BookingPiPdfInput;
      balanceDue: number;
      customerEmail: string | null;
      sender: { id: string; full_name: string };
      supabase: Awaited<ReturnType<typeof createClient>>;
    };

async function loadPi(id: string): Promise<Loaded> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const { data: sender } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).single();
  if (!sender || !PI_ROLES.includes(sender.role)) {
    return { ok: false, response: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
  }

  const { data: booking } = await supabase
    .from("bookings")
    .select("*, space:spaces!bookings_space_id_fkey(id, name), location:locations!bookings_location_id_fkey(id, name), lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company, email), addons:booking_addons(*)")
    .eq("id", id)
    .single();
  if (!booking) return { ok: false, response: NextResponse.json({ error: "Booking not found" }, { status: 404 }) };

  if (PI_BLOCKED_STATUSES.includes(booking.status) || PI_BLOCKED_PAYMENT_STATUSES.includes(booking.payment_status)) {
    return { ok: false, response: NextResponse.json({ error: "This booking has nothing left to pay, so there is no PI to send." }, { status: 400 }) };
  }

  const { data: payments } = await supabase
    .from("booking_payments")
    .select("amount")
    .eq("booking_id", id)
    .eq("status", "verified");
  const paidSoFar = (payments || []).reduce((s, p) => s + Number(p.amount), 0);

  const totals = buildBookingPi({
    booking_number: booking.booking_number,
    space_name: booking.space?.name || "Meeting room",
    duration_hours: booking.duration_hours,
    total_amount: booking.total_amount,
    gst_rate: booking.gst_rate,
    gst_amount: booking.gst_amount,
    total_amount_with_gst: booking.total_amount_with_gst,
    addons: booking.addons || [],
  });
  const balanceDue = piBalanceDue(totals.total, paidSoFar);
  if (balanceDue <= 0) {
    return { ok: false, response: NextResponse.json({ error: "This booking is already paid in full." }, { status: 400 }) };
  }

  const lead = booking.lead;
  const input: BookingPiPdfInput = {
    pi_number: booking.pi_number || bookingPiNumber(booking.booking_number, booking.id),
    booking_number: booking.booking_number,
    customer_name: lead ? `${lead.first_name} ${lead.last_name}` : booking.guest_name || "Customer",
    company: lead?.company || booking.guest_company || null,
    location_name: booking.location?.name || "",
    space_name: booking.space?.name || "Meeting room",
    booking_date: booking.booking_date,
    start_time: booking.start_time,
    end_time: booking.end_time,
    totals,
    paid_so_far: paidSoFar,
    payment_link_url: booking.razorpay_payment_link_url || null,
  };

  return {
    ok: true,
    booking,
    input,
    balanceDue,
    customerEmail: bookingContactEmail(booking),
    sender: { id: sender.id, full_name: sender.full_name },
    supabase,
  };
}

/**
 * GET — the PI as a PDF, for the preview before anything is sent. Read-only by
 * construction: it builds a document and writes nothing, creates no payment
 * link and contacts nobody.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await loadPi(id);
  if (!loaded.ok) return loaded.response;

  const doc = await generateBookingPiPdf(loaded.input);
  return new NextResponse(Buffer.from(doc.output("arraybuffer")), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${loaded.input.pi_number}.pdf"`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * POST — email the PI with the payment link. The link must already exist (the
 * dialog creates it just before, with Razorpay's own notification off, so the
 * customer gets one message, this one). Sending records who, when and to whom;
 * it never changes payment_status.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await loadPi(id);
  if (!loaded.ok) return loaded.response;
  const { booking, input, balanceDue, sender, supabase } = loaded;

  // Staff can send it to another address (their own, to check it, or one the customer
  // gave them); otherwise it goes to the email on the booking.
  const body = (await req.json().catch(() => ({}))) as { to?: unknown; cc?: unknown };
  const recipients = validateRecipients({ to: body.to, cc: body.cc });
  if (!recipients.ok) return NextResponse.json({ error: recipients.error }, { status: 400 });
  const customerEmail = recipients.to || loaded.customerEmail;

  if (!customerEmail) {
    return NextResponse.json({ error: "No customer email on file. Add one to the customer, or download the PI and share it by hand." }, { status: 400 });
  }
  if (!input.payment_link_url) {
    return NextResponse.json({ error: "Create the payment link first, then send the PI." }, { status: 400 });
  }

  const doc = await generateBookingPiPdf(input);
  const pdf = Buffer.from(doc.output("arraybuffer"));

  const { error: sendError } = await resend.emails.send({
    from: EMAIL_FROM,
    replyTo: EMAIL_REPLY_TO,
    to: customerEmail,
    cc: recipients.cc.length > 0 ? recipients.cc : undefined,
    subject: `Proforma invoice ${input.pi_number} for your booking - The WorkVilla`,
    patient: true,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <p>Hi ${input.customer_name},</p>
      <p>Your booking <b>${input.booking_number ?? ""}</b> (${input.space_name}, ${input.location_name}) is confirmed. The proforma invoice is attached.</p>
      <p>You can pay <b>${formatCurrency(balanceDue)}</b> in advance with this secure link, or at the counter when you arrive:</p>
      <p><a href="${input.payment_link_url}">${input.payment_link_url}</a></p>
      <p>This is not a tax invoice. ${BOOKING_PI_NOTES.map((n) => n).join(" ")}</p>
      <p>The WorkVilla</p></div>`,
    attachments: [{ filename: `${input.pi_number}.pdf`, content: pdf, contentType: "application/pdf" }],
  });
  if (sendError) {
    return NextResponse.json({ error: "The email could not be sent. Try again, or download the PI and share it by hand." }, { status: 502 });
  }

  const sentAt = new Date().toISOString();
  await supabase
    .from("bookings")
    .update({ pi_number: input.pi_number, pi_sent_at: sentAt, pi_sent_by: sender.id, pi_sent_to: recipients.cc.length > 0 ? `${customerEmail} · cc ${recipients.cc.join(", ")}` : customerEmail })
    .eq("id", id);

  // Lists the PI in Receivables as pending and lets the follow-up ladder chase
  // it. Never blocks the send: the email has already gone.
  const { statementId } = await upsertBookingPiStatement(createAdminClient(), {
    bookingId: id,
    leadId: booking.lead_id ?? null,
    piNumber: input.pi_number,
    totals: input.totals,
    gstRate: Number(booking.gst_rate) || 0,
    linkId: booking.razorpay_payment_link_id ?? null,
    linkUrl: input.payment_link_url,
  });

  void logAudit(supabase, {
    entityType: "booking",
    entityId: id,
    action: "update",
    performedBy: sender.id,
    changes: { pi_number: { old: booking.pi_number ?? null, new: input.pi_number }, pi_sent_to: { old: null, new: customerEmail }, ...(recipients.cc.length > 0 ? { pi_cc: { old: null, new: recipients.cc.join(", ") } } : {}) },
  });

  return NextResponse.json({ data: { pi_number: input.pi_number, pi_sent_at: sentAt, pi_sent_to: recipients.cc.length > 0 ? `${customerEmail} · cc ${recipients.cc.join(", ")}` : customerEmail, statement_id: statementId,
      // The email has gone; say so if it could not be listed in Receivables, or nobody will chase it.
      warning: statementId ? null : "The PI was emailed but could not be added to Receivables. Send it again to retry, or tell accounts." } });
}
