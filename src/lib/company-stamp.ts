import type jsPDF from "jspdf";
import { COMPANY_SEAL_BASE64 } from "@/lib/seal-data";
import { COMPANY_SIGNATURE_BASE64 } from "@/lib/signature-data";

/** Unique, human-quotable ID for a single stamp action — printed on the PDF and logged to audit_trail so a stamped document can be traced back to the action that produced it. */
export function generateStampReference(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SEAL-${ts}-${rand}`;
}

/**
 * Draws the company signature + seal directly above a signature line, using
 * the caller's own layout coordinates — no text-detection/guessing involved.
 * `x` is the column's left edge, `lineY` is the y where the signature line
 * is drawn, `maxWidth` bounds the column so the seal never bleeds into the
 * neighboring (counterparty) column. `refText`, if given, is printed in
 * small type beside the seal for traceability.
 */
export function drawCompanyStamp(doc: jsPDF, x: number, lineY: number, maxWidth: number, refText?: string): void {
  const sigH = 16;
  let sigW = sigH;
  try {
    const props = doc.getImageProperties(COMPANY_SIGNATURE_BASE64);
    sigW = sigH * (props.width / props.height);
  } catch {
    /* keep square fallback */
  }
  const sigY = lineY - sigH - 2;
  try {
    doc.addImage(COMPANY_SIGNATURE_BASE64, "PNG", x, sigY, sigW, sigH);
  } catch {
    /* signature failed to load — silently skip */
  }

  const sealR = 10;
  const sealCx = x + sigW + 4 + sealR;
  const sealCy = sigY + sigH / 2;
  const sealFits = sealCx + sealR <= x + maxWidth;
  if (sealFits) {
    try {
      doc.addImage(COMPANY_SEAL_BASE64, "PNG", sealCx - sealR, sealCy - sealR, sealR * 2, sealR * 2);
    } catch {
      /* seal failed to load — silently skip */
    }
  }

  if (refText) {
    doc.setFontSize(5.5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(150, 150, 150);
    const refX = sealFits ? sealCx + sealR + 3 : x + sigW + 4;
    doc.text(`Ref: ${refText}`, refX, sealCy + 1);
  }
}

/**
 * Same stamp, sized and vertically centered to fit inside an arbitrary
 * rectangle (e.g. a jspdf-autotable cell) instead of sitting above a line.
 * Used where the signature area is a table cell, not free-floating text.
 */
export function drawCompanyStampInBox(
  doc: jsPDF,
  box: { x: number; y: number; width: number; height: number },
  refText?: string
): void {
  const pad = 2;
  const availH = box.height - pad * 2;
  const sigH = Math.max(6, Math.min(14, availH));
  let sigW = sigH;
  try {
    const props = doc.getImageProperties(COMPANY_SIGNATURE_BASE64);
    sigW = sigH * (props.width / props.height);
  } catch {
    /* keep square fallback */
  }
  const sigX = box.x + pad;
  const sigY = box.y + (box.height - sigH) / 2;
  try {
    doc.addImage(COMPANY_SIGNATURE_BASE64, "PNG", sigX, sigY, sigW, sigH);
  } catch {
    /* signature failed to load — silently skip */
  }

  const sealR = Math.max(4, Math.min(9, availH / 2));
  const sealCx = sigX + sigW + 3 + sealR;
  const sealCy = box.y + box.height / 2;
  const sealFits = sealCx + sealR <= box.x + box.width - pad;
  if (sealFits) {
    try {
      doc.addImage(COMPANY_SEAL_BASE64, "PNG", sealCx - sealR, sealCy - sealR, sealR * 2, sealR * 2);
    } catch {
      /* seal failed to load — silently skip */
    }
  }

  if (refText) {
    doc.setFontSize(5);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(150, 150, 150);
    const refX = sealFits ? sealCx + sealR + 2 : sigX + sigW + 3;
    if (refX < box.x + box.width - pad) {
      doc.text(`Ref: ${refText}`, refX, box.y + box.height - pad);
    }
  }
}
