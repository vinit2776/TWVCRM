import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";
import { stampSignatureOnPdf } from "@/lib/uploads/stamp-pdf-signature";
import { isHandoffV2Enabled } from "@/lib/tally-handoff-server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { COMPANY_BANK_DETAILS } from "@/lib/constants";

/**
 * POST /api/booking-gst-tasks/[id]/upload-gst-invoice
 *
 * Accounts uploads the Tally GST invoice PDF for a non-contract booking.
 * Mirrors the billing-statements version but:
 *   - id = booking_gst_tasks.id (not billing_statements.id)
 *   - Amount must equal booking.total_amount_with_gst (GST-inclusive)
 *   - No Razorpay link created (booking is already paid when task appears)
 *   - Transitions handoff_state to ready_to_send
 */
export const dynamic = "force-dynamic";

interface UploadBody {
  tally_invoice_number: string;
  tally_invoice_series: "SDIPL-REG" | "SDIPL-UNREG";
  irn: string | null;
  invoice_date: string;
  invoice_amount: number;
  autofill_source: "qr" | "pdf_text" | "bridge_match" | "manual";
  qr_payload: Record<string, unknown> | null;
  nic_signature_verified: boolean;
}

function badRequest(reason: string) {
  return NextResponse.json({ error: reason }, { status: 422 });
}

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
    return NextResponse.json({ error: "Tally handoff v2 is not enabled." }, { status: 409 });
  }

  // ── Parse multipart form ─────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return badRequest("Could not parse upload");
  }

  const file = formData.get("file") as File | null;
  const metaRaw = formData.get("meta") as string | null;
  if (!file) return badRequest("No file provided");
  if (!metaRaw) return badRequest("No upload metadata provided");

  let meta: UploadBody;
  try {
    meta = JSON.parse(metaRaw) as UploadBody;
  } catch {
    return badRequest("Invalid meta JSON");
  }

  if (!meta.irn?.trim()) meta.irn = null;

  // ── Fetch the booking_gst_task + booking + lead ──────────────────────────
  const { data: taskRow } = await adminClient
    .from("booking_gst_tasks")
    .select(`
      id, handoff_state, booking_id,
      booking:bookings!booking_gst_tasks_booking_id_fkey(
        id, booking_number, total_amount_with_gst, payment_status,
        guest_name, guest_email, guest_phone, guest_company,
        lead:leads!bookings_lead_id_fkey(id, first_name, last_name, company, email, mobile, phone, gst_number)
      )
    `)
    .eq("id", id)
    .maybeSingle();

  if (!taskRow) return NextResponse.json({ error: "Booking GST task not found" }, { status: 404 });

  const task = taskRow as unknown as {
    id: string;
    handoff_state: string;
    booking_id: string;
    booking: {
      id: string;
      booking_number: string | null;
      total_amount_with_gst: number;
      payment_status: string;
      guest_name: string | null;
      guest_email: string | null;
      guest_phone: string | null;
      guest_company: string | null;
      lead: {
        id: string;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
        email: string | null;
        mobile: string | null;
        phone: string | null;
        gst_number: string | null;
      } | null;
    } | null;
  };

  if (!task.booking) return NextResponse.json({ error: "Booking not found" }, { status: 404 });

  // Fix #1: Block re-uploads on completed tasks — would re-open the task and re-send the email.
  if (task.handoff_state === "complete") {
    return badRequest("This task is already complete. Re-uploading is not allowed.");
  }

  // ── Hard-block rules ──────────────────────────────────────────────────────
  // Amount must match total_amount_with_gst (GST-inclusive for bookings).
  // Compare at whole-rupee level — Razorpay collects in paise and the stored
  // amount may differ by a few paise from the rounded GST invoice amount.
  if (Math.round(Number(meta.invoice_amount)) !== Math.round(Number(task.booking.total_amount_with_gst))) {
    return badRequest(
      `Tally amount ₹${meta.invoice_amount} does not match booking total ₹${task.booking.total_amount_with_gst}. ` +
      `Fix the Tally voucher; no override is allowed.`,
    );
  }

  const customerGstin = task.booking.lead?.gst_number ?? null;
  const customerHasGstin = !!customerGstin;

  if (customerHasGstin && meta.tally_invoice_series !== "SDIPL-REG") {
    return badRequest("Customer has GSTIN — must use A-series (SDIPL-REG) invoice.");
  }
  if (!customerHasGstin && meta.tally_invoice_series !== "SDIPL-UNREG") {
    return badRequest("Customer has no GSTIN — must use B-series (SDIPL-UNREG) invoice without IRN.");
  }

  if (meta.tally_invoice_series === "SDIPL-REG") {
    if (meta.irn && meta.irn.length !== 64) {
      return badRequest("IRN must be exactly 64 characters if provided.");
    }
  } else {
    if (meta.irn) {
      return badRequest("B-series invoices must NOT carry an IRN.");
    }
  }

  const expectedPrefix = meta.tally_invoice_series === "SDIPL-REG" ? "SD/A/" : "SD/B/";
  if (!meta.tally_invoice_number.startsWith(expectedPrefix)) {
    return badRequest(
      `Invoice number "${meta.tally_invoice_number}" does not match expected ${expectedPrefix}* prefix.`,
    );
  }

  // ── Normalize + stamp + upload PDF ───────────────────────────────────────
  // File-size protection (#9): normalizeUploadServer checks file.size (metadata,
  // not a full read) and rejects anything > 50 MB before buffering.
  const allowedTypes = ["application/pdf", "image/jpeg", "image/png"];
  if (!allowedTypes.includes(file.type)) {
    return badRequest("Only PDF / JPEG / PNG files are allowed.");
  }

  let normalized: { buffer: Buffer; mimeType: string; ext: string };
  try {
    normalized = await normalizeUploadServer(file);
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  if (normalized.mimeType === "application/pdf") {
    normalized.buffer = await stampSignatureOnPdf(normalized.buffer);
  }

  const timestamp = Date.now();
  const safeNumber = meta.tally_invoice_number.replace(/[^\w-]/g, "_");
  const filePath = `tally-handoff/bookings/${task.booking_id}/${timestamp}-${safeNumber}.${normalized.ext}`;

  const { error: uploadError } = await supabase.storage
    .from("crm-documents")
    .upload(filePath, normalized.buffer, { contentType: normalized.mimeType });

  if (uploadError) {
    return NextResponse.json({ error: `Upload failed: ${uploadError.message}` }, { status: 500 });
  }

  // ── Insert gst_invoice_uploads row ────────────────────────────────────────
  const { data: insertedUpload, error: insertErr } = await supabase
    .from("gst_invoice_uploads")
    .insert({
      billing_statement_id: null,
      booking_gst_task_id: task.id,
      uploaded_by: user.id,
      tally_invoice_number: meta.tally_invoice_number,
      tally_invoice_series: meta.tally_invoice_series,
      irn: meta.irn,
      invoice_date: meta.invoice_date,
      invoice_amount: meta.invoice_amount,
      invoice_pdf_url: filePath,
      qr_payload: meta.qr_payload,
      autofill_source: meta.autofill_source,
      nic_signature_verified: meta.nic_signature_verified,
      // name_check_status "approved" is intentional (#10): accounts is the
      // uploader and has already verified the invoice against the booking.
      // The booking task flow has no separate name-check approval step in the UI.
      name_check_status: "approved",
      name_check_decided_by: user.id,
      name_check_decided_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // ── Mirror onto booking_gst_tasks ────────────────────────────────────────
  // Fix #6: check error — upload row is committed; if state transition fails
  // we surface it rather than silently leaving the task in gst_to_issue.
  const { error: taskUpdateErr } = await adminClient
    .from("booking_gst_tasks")
    .update({
      gst_invoice_number: meta.tally_invoice_number,
      tally_invoice_number: meta.tally_invoice_number,
      tally_total_amount: meta.invoice_amount,
      issuance_channel: "tally",
      handoff_state: "ready_to_send",
      updated_at: new Date().toISOString(),
    })
    .eq("id", task.id);

  if (taskUpdateErr) {
    return NextResponse.json(
      { error: `Invoice saved (id: ${insertedUpload.id}) but task status update failed: ${taskUpdateErr.message}. Refresh and check task state.` },
      { status: 500 },
    );
  }

  // ── Send intimation email to accounts ────────────────────────────────────
  // (fire-and-forget — non-blocking)
  const customerName = task.booking.lead?.company
    || task.booking.guest_company
    || [task.booking.lead?.first_name ?? task.booking.guest_name, task.booking.lead?.last_name].filter(Boolean).join(" ")
    || "Customer";
  const customerEmail = task.booking.lead?.email ?? task.booking.guest_email ?? null;

  // Auto-send the invoice email immediately (booking is always already paid)
  let pdfAttachment: Buffer | null = null;
  try {
    const { data: pdfData } = await supabase.storage.from("crm-documents").download(filePath);
    if (pdfData) pdfAttachment = Buffer.from(await pdfData.arrayBuffer());
  } catch {
    // non-blocking
  }

  const invoiceNumber = meta.tally_invoice_number;
  const amountFormatted = Math.round(Number(meta.invoice_amount)).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const invoiceDateFormatted = new Date(meta.invoice_date + "T00:00:00").toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric",
  });

  const emailHtml = `
    <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#015E65;padding:24px 32px;">
        <h1 style="color:white;margin:0;font-size:20px;">The WorkVilla</h1>
        <p style="color:#00AE6C;margin:4px 0 0;font-size:12px;">Tax Invoice</p>
      </div>
      <div style="padding:32px;">
        <p style="color:#333;font-size:14px;">Dear ${customerName},</p>
        <p style="color:#333;font-size:14px;">Thank you for using The WorkVilla. Please find attached the GST tax invoice for your booking.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
          <tr><td style="padding:6px 0;color:#666;">Invoice No.</td><td style="padding:6px 0;font-weight:600;">${invoiceNumber}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Booking</td><td style="padding:6px 0;">${task.booking.booking_number ?? "—"}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Invoice Date</td><td style="padding:6px 0;">${invoiceDateFormatted}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Amount</td><td style="padding:6px 0;font-weight:600;color:#015E65;font-size:16px;">Rs. ${amountFormatted}</td></tr>
        </table>
        <p style="color:#333;font-size:14px;">This invoice is for your records. Payment has been received in full.</p>
        <p style="color:#333;font-size:14px;margin-top:24px;">Warm regards,<br/><strong>The WorkVilla</strong></p>
      </div>
      <div style="background:#015E65;padding:12px 32px;text-align:center;">
        <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
        <p style="color:rgba(255,255,255,0.6);margin:4px 0 0;font-size:9px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | GSTIN: 33AAACU4245J1ZF</p>
      </div>
    </div>
  `;

  let emailWarning: string | null = null;
  if (customerEmail) {
    try {
      const safeFilename = `${invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "-")}.pdf`;
      const sendResult = await resend.emails.send({
        from: EMAIL_FROM,
        replyTo: EMAIL_REPLY_TO,
        to: [customerEmail],
        bcc: [EMAIL_REPLY_TO],
        subject: `Tax Invoice ${invoiceNumber} — The WorkVilla`,
        html: emailHtml,
        attachments: pdfAttachment
          ? [{ filename: safeFilename, content: pdfAttachment, contentType: "application/pdf" }]
          : undefined,
      });
      if (sendResult.error) throw new Error(sendResult.error.message);

      // Stamp delivery
      await adminClient
        .from("booking_gst_tasks")
        .update({
          gst_invoice_sent_at: new Date().toISOString(),
          gst_invoice_sent_to: customerEmail,
          tally_delivered_at: new Date().toISOString(),
          handoff_state: "complete",
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id);

      return NextResponse.json({ ok: true, upload_id: insertedUpload.id, handoff_state: "complete" });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      emailWarning = `Email delivery failed: ${errMsg}. Invoice uploaded — use Save & send to retry.`;
    }
  }

  return NextResponse.json({
    ok: true,
    upload_id: insertedUpload.id,
    handoff_state: "ready_to_send",
    email_warning: emailWarning ?? undefined,
  });
}
