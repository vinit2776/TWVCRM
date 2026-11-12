/**
 * PDF helpers for embedding the e-invoice QR code, IRN, and acknowledgement
 * details on a tax invoice PDF.
 *
 * NIC mandates that the QR contains the JWT-signed string returned by the
 * IRP — `signed_qr_code` from our gst_invoices row. The QR can be scanned
 * by any GSTN-compatible app to verify the invoice's authenticity.
 *
 * The functions here are intentionally framework-agnostic: callers pass in
 * a `jsPDF` instance and a position; we just render. This lets us drop the
 * QR block onto any existing tax-invoice PDF generator without coupling.
 */

import QRCode from "qrcode";
import type { jsPDF } from "jspdf";

export interface EInvoiceMarkers {
  irn: string;                    // 64-char IRN
  ack_no: string;
  ack_date: string;               // ISO timestamp (we'll format for display)
  signed_qr_code: string;         // JWT — the actual content of the QR
}

/**
 * Render the QR code as a Data URL (Base64 PNG). Useful when generating
 * the PDF on the server and embedding via jsPDF's addImage().
 *
 * Size convention: 256×256 px. Error correction "M" (15% recovery) — NIC
 * recommends "L" but "M" is more robust for printers without losing
 * scannability.
 */
export async function renderQrAsDataUrl(signedQr: string): Promise<string> {
  return QRCode.toDataURL(signedQr, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 256,
  });
}

/**
 * Draw the QR + IRN + Ack block onto a jsPDF document at (x, y).
 *
 * Layout (default 60×60 mm box):
 *
 *   ┌─────────────────────────┐
 *   │ ┌──────┐  IRN: <hash>   │
 *   │ │  QR  │  AckNo: NNNNN  │
 *   │ │      │  AckDate: ...  │
 *   │ └──────┘                │
 *   │  e-Invoice Verified     │
 *   └─────────────────────────┘
 *
 * Caller passes in the jsPDF instance, position, and marker data.
 * Returns the height consumed (so caller can advance their cursor).
 */
export async function drawEInvoiceBlock(
  pdf: jsPDF,
  markers: EInvoiceMarkers,
  position: { x: number; y: number; widthMm?: number },
): Promise<number> {
  const widthMm = position.widthMm ?? 90;
  const qrSizeMm = 30;
  const padMm = 2;
  const lineHeight = 4;

  // Render QR
  const qrDataUrl = await renderQrAsDataUrl(markers.signed_qr_code);

  // Box outline
  pdf.setLineWidth(0.2);
  pdf.rect(position.x, position.y, widthMm, qrSizeMm + 2 * padMm);

  // QR image
  pdf.addImage(qrDataUrl, "PNG", position.x + padMm, position.y + padMm, qrSizeMm, qrSizeMm, undefined, "FAST");

  // Text block
  const textX = position.x + qrSizeMm + 2 * padMm;
  let textY = position.y + padMm + lineHeight;

  pdf.setFontSize(7);
  pdf.setFont("helvetica", "bold");
  pdf.text("e-Invoice", textX, textY);
  textY += lineHeight;

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(6);

  pdf.text("IRN:", textX, textY);
  pdf.text(truncateMid(markers.irn, 32), textX + 8, textY);
  textY += lineHeight - 1;

  pdf.text("Ack No:", textX, textY);
  pdf.text(markers.ack_no, textX + 12, textY);
  textY += lineHeight - 1;

  pdf.text("Ack Date:", textX, textY);
  pdf.text(formatAckDate(markers.ack_date), textX + 14, textY);
  textY += lineHeight;

  pdf.setFont("helvetica", "italic");
  pdf.setFontSize(5.5);
  pdf.text("Verified by GSTN — scan QR to validate", textX, textY);

  return qrSizeMm + 2 * padMm;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncateMid(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor((max - 1) / 2);
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function formatAckDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
