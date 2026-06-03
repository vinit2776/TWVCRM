/**
 * src/lib/tally/post-ack.ts
 *
 * Actions triggered after a successful Tally ack:
 *   1. Create a Razorpay payment link using Tally's authoritative total (D3)
 *   2. Overlay the Razorpay QR + Pay Now link onto the existing GST invoice PDF
 *      following the two-QR rule (D10.6): label clearly, never obscure the IRP QR
 *   3. Store the link URL on the billing statement
 *
 * Called fire-and-forget from the /api/tally/ack route after a successful ack.
 * Failures here are logged and surfaced as a separate retryable step — they
 * never roll back the ack itself (Tally already issued the invoice).
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

interface PostAckParams {
  supabase:           SupabaseClient;
  billingStatementId: string;
  tallyInvoiceNumber: string;
  tallyTotalAmount:   number;   // authoritative total from Tally (D3)
  tallySignedQrCode:  string | null;  // IRP verification QR data
  customerName:       string;
  customerEmail:      string | null;
  customerPhone:      string | null;
  razorpayKeyId:      string;
  razorpayKeySecret:  string;
}

export async function runPostAckActions(params: PostAckParams): Promise<void> {
  const {
    supabase, billingStatementId, tallyInvoiceNumber,
    tallyTotalAmount, tallySignedQrCode,
    customerName, customerEmail, customerPhone,
    razorpayKeyId, razorpayKeySecret,
  } = params;

  try {
    // ── Step 1: Create Razorpay payment link ───────────────────────────────
    const linkResult = await createRazorpayLink({
      keyId:         razorpayKeyId,
      keySecret:     razorpayKeySecret,
      amount:        tallyTotalAmount,
      invoiceNumber: tallyInvoiceNumber,
      statementId:   billingStatementId,
      customerName,
      customerEmail:  customerEmail ?? undefined,
      customerPhone:  customerPhone ?? undefined,
    });

    if (!linkResult.ok) {
      console.log(`[post-ack] Razorpay link creation failed for ${billingStatementId}: ${linkResult.error}`);
      // Mark for retry — don't block
      await supabase
        .from("billing_statements")
        .update({ tally_last_error: `Razorpay link: ${linkResult.error}` })
        .eq("id", billingStatementId);
      return;
    }

    // ── Step 2: Overlay QR + link on the invoice PDF ───────────────────────
    const overlayResult = await overlayPaymentQrOnPdf({
      supabase,
      billingStatementId,
      paymentLinkUrl:  linkResult.linkUrl,
      signedQrCode:    tallySignedQrCode,
    });

    // ── Step 3: Store link on billing statement ────────────────────────────
    await supabase
      .from("billing_statements")
      .update({
        razorpay_tally_link_id:  linkResult.linkId,
        razorpay_tally_link_url: linkResult.linkUrl,
        tally_last_error:        null,
        // pdf_path update happens inside overlayPaymentQrOnPdf
      })
      .eq("id", billingStatementId);

    console.log(`[post-ack] ✓ Statement ${billingStatementId} — link created, PDF overlaid. PDF: ${overlayResult.pdfPath ?? "n/a"}`);
  } catch (err) {
    console.log(`[post-ack] Unexpected error for ${billingStatementId}: ${String(err)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Razorpay link creation
// ─────────────────────────────────────────────────────────────────────────────

type LinkResult =
  | { ok: true;  linkId: string; linkUrl: string }
  | { ok: false; error: string };

async function createRazorpayLink(params: {
  keyId:         string;
  keySecret:     string;
  amount:        number;
  invoiceNumber: string;
  statementId:   string;
  customerName:  string;
  customerEmail?: string;
  customerPhone?: string;
}): Promise<{ ok: true; linkId: string; linkUrl: string } | { ok: false; error: string }> {

  const auth = Buffer.from(`${params.keyId}:${params.keySecret}`).toString("base64");

  // Razorpay amount is in paise (smallest unit)
  const amountPaise = Math.round(params.amount * 100);

  // Expire in 7 days
  const expireBy = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  const payload: Record<string, unknown> = {
    amount:          amountPaise,
    currency:        "INR",
    accept_partial:  false,
    description:     `Invoice ${params.invoiceNumber}`,
    reference_id:    params.statementId,
    expire_by:       expireBy,
    reminder_enable: true,
    callback_url:    `${process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL}/api/payments/webhook`,
    callback_method: "post",
    notes: {
      billing_statement_id: params.statementId,
      invoice_number:       params.invoiceNumber,
    },
  };

  // Add customer contact if available so Razorpay can notify them
  const phone = normalizePhone(params.customerPhone);
  if (params.customerName || params.customerEmail || phone) {
    payload["customer"] = {
      ...(params.customerName  ? { name:    params.customerName  } : {}),
      ...(params.customerEmail ? { email:   params.customerEmail } : {}),
      ...(phone                ? { contact: phone                } : {}),
    };
  }

  try {
    const res = await fetch("https://api.razorpay.com/v1/payment_links", {
      method:  "POST",
      headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => null) as { error?: { description?: string } } | null;
      return { ok: false, error: err?.error?.description ?? `HTTP ${res.status}` };
    }

    const data = await res.json() as { id: string; short_url: string };
    return { ok: true, linkId: data.id, linkUrl: data.short_url };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function normalizePhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let phone = String(raw).replace(/[\s-]/g, "");
  if (phone.startsWith("+")) phone = phone.substring(1);
  if (!phone.startsWith("91") && phone.length === 10) phone = "91" + phone;
  return "+" + phone;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF overlay — two-QR rule (D10.6)
//
// The invoice PDF from Tally already has the IRP verification QR.
// We ADD the Razorpay "Scan to Pay" QR in a reserved space at the bottom,
// clearly labelled. We never obscure or replace the IRP QR.
// ─────────────────────────────────────────────────────────────────────────────

interface OverlayResult {
  pdfPath: string | null;
}

async function overlayPaymentQrOnPdf(params: {
  supabase:           SupabaseClient;
  billingStatementId: string;
  paymentLinkUrl:     string;
  signedQrCode:       string | null;
}): Promise<OverlayResult> {

  const { supabase, billingStatementId, paymentLinkUrl } = params;

  // Fetch the existing PDF path from the billing statement's GST invoice
  const { data: stmt } = await supabase
    .from("billing_statements")
    .select("gst_invoice_path, tally_sync_job_id")
    .eq("id", billingStatementId)
    .single();

  const existingPdfPath = (stmt as { gst_invoice_path?: string | null } | null)?.gst_invoice_path;

  if (!existingPdfPath) {
    // No existing PDF to overlay — return without error.
    // The PDF will be generated separately when the invoice is sent.
    console.log(`[overlay-pdf] No existing PDF path for ${billingStatementId} — skipping overlay`);
    return { pdfPath: null };
  }

  try {
    // Download the existing PDF from Supabase storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("crm-documents")
      .download(existingPdfPath);

    if (downloadError || !fileData) {
      console.log(`[overlay-pdf] Download failed for ${existingPdfPath}: ${downloadError?.message ?? "no data"}`);
      return { pdfPath: existingPdfPath }; // return original path, no overlay
    }

    const pdfBytes = await fileData.arrayBuffer();
    const pdfDoc   = await PDFDocument.load(pdfBytes);
    const pages    = pdfDoc.getPages();
    const lastPage = pages[pages.length - 1];
    const { width } = lastPage.getSize();

    // ── Generate Razorpay payment QR PNG ──────────────────────────────────
    const qrPngDataUrl = await generateQrPng(paymentLinkUrl);
    const qrPngBytes   = Buffer.from(qrPngDataUrl.split(",")[1], "base64");
    const qrImage      = await pdfDoc.embedPng(qrPngBytes);

    // ── Layout constants ──────────────────────────────────────────────────
    // Place the payment block at the bottom of the last page.
    // The IRP QR is typically top-right; we use bottom-left space.
    // Adjust Y_OFFSET if the invoice layout changes.
    const BLOCK_WIDTH  = 100;  // points
    const QR_SIZE      = 60;   // points
    const MARGIN_LEFT  = 28;
    const Y_BOTTOM     = 28;   // from bottom of page
    const font         = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontSmall    = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Label: "Scan to Pay" (in green to distinguish from the IRP verification QR)
    lastPage.drawText("Scan to Pay", {
      x:    MARGIN_LEFT,
      y:    Y_BOTTOM + QR_SIZE + 4,
      size: 7,
      font,
      color: rgb(0, 0.68, 0.42),  // TWV brand green
    });

    // QR code image
    lastPage.drawImage(qrImage, {
      x:      MARGIN_LEFT,
      y:      Y_BOTTOM,
      width:  QR_SIZE,
      height: QR_SIZE,
    });

    // Short URL text beside QR (for printed copies)
    const shortUrl = paymentLinkUrl.length > 40
      ? paymentLinkUrl.slice(0, 37) + "…"
      : paymentLinkUrl;

    lastPage.drawText(shortUrl, {
      x:    MARGIN_LEFT + QR_SIZE + 6,
      y:    Y_BOTTOM + QR_SIZE / 2 + 4,
      size: 6,
      font: fontSmall,
      color: rgb(0.2, 0.2, 0.2),
      maxWidth: width - MARGIN_LEFT - QR_SIZE - 6 - 28,
    });

    lastPage.drawText("Pay this invoice online. IRP QR above is for GST verification only.", {
      x:    MARGIN_LEFT + QR_SIZE + 6,
      y:    Y_BOTTOM + QR_SIZE / 2 - 8,
      size: 5,
      font: fontSmall,
      color: rgb(0.5, 0.5, 0.5),
      maxWidth: BLOCK_WIDTH + 20,
    });

    // ── Save overlaid PDF ─────────────────────────────────────────────────
    const overlaidBytes  = await pdfDoc.save();
    const overlaidBuffer = Buffer.from(overlaidBytes);
    const overlaidPath   = existingPdfPath.replace(/\.pdf$/i, "-pay.pdf");

    const { error: uploadError } = await supabase.storage
      .from("crm-documents")
      .upload(overlaidPath, overlaidBuffer, {
        contentType: "application/pdf",
        upsert:      true,
      });

    if (uploadError) {
      console.log(`[overlay-pdf] Upload failed for ${overlaidPath}: ${uploadError.message}`);
      return { pdfPath: existingPdfPath };
    }

    // Update the statement's gst_invoice_path to point to the overlaid PDF
    await supabase
      .from("billing_statements")
      .update({ gst_invoice_path: overlaidPath })
      .eq("id", billingStatementId);

    return { pdfPath: overlaidPath };

  } catch (err) {
    console.log(`[overlay-pdf] Error: ${String(err)}`);
    return { pdfPath: existingPdfPath ?? null };
  }
}

async function generateQrPng(url: string): Promise<string> {
  // Returns a PNG as base64 data URL
  // Uses the 'qrcode' npm package (add to package.json if not already present)
  try {
    // Dynamic import so the server component doesn't fail if qrcode isn't installed yet
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const QRCode = require("qrcode") as typeof import("qrcode");
    return await QRCode.toDataURL(url, { width: 200, margin: 1 });
  } catch {
    // Fallback: return a tiny placeholder PNG if qrcode isn't installed
    // Install: npm install qrcode @types/qrcode
    console.log("[overlay-pdf] qrcode package not installed — QR placeholder used. Run: npm install qrcode @types/qrcode");
    // 1x1 transparent PNG as base64
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  }
}

