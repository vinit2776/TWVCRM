import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { formatCurrency } from "@/lib/utils";
import { isHandoffV2Enabled } from "@/lib/tally-handoff-server";

/**
 * POST /api/booking-gst-tasks/[id]/inbox-send
 *
 * "Save & send" for a booking GST task whose invoice was uploaded but email
 * delivery failed at upload time (rare path). Fetches the upload PDF and
 * resends it to the customer. Since booking tasks are always already paid,
 * transitions directly to "complete".
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role")
    .eq("auth_id", user.id)
    .maybeSingle();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!["accounts", "admin"].includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const adminClient = await createAdminClient();
  if (!(await isHandoffV2Enabled(adminClient))) {
    return NextResponse.json({ error: "Tally handoff v2 is not enabled" }, { status: 409 });
  }

  // ── Fetch task + booking ─────────────────────────────────────────────────
  const { data: taskRow } = await adminClient
    .from("booking_gst_tasks")
    .select(`
      id, handoff_state, tally_delivered_at, booking_id,
      booking:bookings!booking_gst_tasks_booking_id_fkey(
        id, booking_number, total_amount_with_gst,
        guest_name, guest_email,
        lead:leads!bookings_lead_id_fkey(first_name, last_name, company, email, billing_emails)
      )
    `)
    .eq("id", id)
    .maybeSingle();

  if (!taskRow) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const task = taskRow as unknown as {
    id: string;
    handoff_state: string;
    tally_delivered_at: string | null;
    booking_id: string;
    booking: {
      id: string;
      booking_number: string | null;
      total_amount_with_gst: number;
      guest_name: string | null;
      guest_email: string | null;
      lead: { first_name: string | null; last_name: string | null; company: string | null; email: string | null; billing_emails: string[] | null } | null;
    } | null;
  };

  if (task.tally_delivered_at) {
    return NextResponse.json({ error: "Invoice already delivered." }, { status: 409 });
  }

  if (task.handoff_state !== "ready_to_send") {
    return NextResponse.json(
      { error: `Task is in state "${task.handoff_state}", not ready_to_send.` },
      { status: 409 },
    );
  }

  // ── Fetch the upload ─────────────────────────────────────────────────────
  const { data: upload } = await supabase
    .from("gst_invoice_uploads")
    .select("id, tally_invoice_number, invoice_pdf_url, invoice_amount")
    .eq("booking_gst_task_id", id)
    .is("superseded_by", null)
    .order("uploaded_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!upload) return NextResponse.json({ error: "No GST invoice upload found" }, { status: 409 });

  // Fix #3: Re-validate amount at send time — booking total may have changed
  // since upload, and client-side canSend check is bypassable via direct POST.
  if (task.booking && Number(upload.invoice_amount).toFixed(2) !== Number(task.booking.total_amount_with_gst).toFixed(2)) {
    return NextResponse.json(
      { error: `Invoice amount ₹${upload.invoice_amount} no longer matches booking total ₹${task.booking.total_amount_with_gst}. Re-upload the corrected invoice.` },
      { status: 409 },
    );
  }

  const { data: fileBlob, error: downloadErr } = await supabase.storage
    .from("crm-documents")
    .download(upload.invoice_pdf_url as string);

  if (downloadErr || !fileBlob) {
    return NextResponse.json({ error: `Could not retrieve PDF: ${downloadErr?.message ?? "unknown"}` }, { status: 500 });
  }

  const pdfBuffer = Buffer.from(await fileBlob.arrayBuffer());

  // ── Resolve recipient list ───────────────────────────────────────────────
  let extraRecipients: string[] = [];
  try {
    const body = await request.json().catch(() => ({})) as { extra_recipients?: string[] };
    if (Array.isArray(body.extra_recipients)) extraRecipients = body.extra_recipients;
  } catch { /* body may be empty */ }

  // ── Compose email ────────────────────────────────────────────────────────
  const lead = task.booking?.lead;
  const recipientEmail = lead?.email ?? task.booking?.guest_email ?? null;
  if (!recipientEmail) {
    return NextResponse.json({ error: "Customer has no email on file." }, { status: 422 });
  }

  const allRecipients = Array.from(new Set([
    recipientEmail,
    ...(lead?.billing_emails ?? []),
    ...extraRecipients,
  ].filter(Boolean)));

  const partyName = lead?.company
    || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ")
    || task.booking?.guest_name
    || "Customer";

  const invoiceNumber = upload.tally_invoice_number as string;
  const totalDisplay = formatCurrency(Number(task.booking?.total_amount_with_gst ?? 0));
  const filename = `${invoiceNumber.replace(/[^\w-]/g, "_")}.pdf`;

  const result = await resend.emails.send({
    from: EMAIL_FROM,
    to: allRecipients,
    bcc: [EMAIL_REPLY_TO],
    replyTo: EMAIL_REPLY_TO,
    subject: `GST tax invoice ${invoiceNumber} — ${totalDisplay} — The WorkVilla`,
    html: `
      <p>Dear ${partyName},</p>
      <p>Thank you for using The WorkVilla. Please find attached the GST tax invoice
         <strong>${invoiceNumber}</strong> for <strong>${totalDisplay}</strong>
         (Booking: ${task.booking?.booking_number ?? "—"}).</p>
      <p>Payment has been received in full. This invoice is for your records.</p>
      <p>Regards,<br/>The WorkVilla — Accounts</p>
    `,
    attachments: [{ filename, content: pdfBuffer, contentType: "application/pdf" }],
  });

  if (result.error) {
    return NextResponse.json({ error: `Email delivery failed: ${result.error.message}` }, { status: 500 });
  }

  // ── Stamp delivery → complete ─────────────────────────────────────────────
  const now = new Date().toISOString();
  await adminClient
    .from("booking_gst_tasks")
    .update({
      tally_delivered_at: now,
      gst_invoice_sent_at: now,
      gst_invoice_sent_to: recipientEmail,
      handoff_state: "complete",
      updated_at: now,
    })
    .eq("id", id);

  return NextResponse.json({ ok: true, emailed_to: allRecipients.join(","), handoff_state: "complete" });
}
