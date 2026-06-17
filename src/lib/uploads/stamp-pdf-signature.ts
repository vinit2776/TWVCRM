// Server-side utility: overlays the authorised signatory block onto the
// bottom-right of the last page of a PDF using pdf-lib.
//
// Block layout (bottom-right, mirroring the CRM GST invoice convention):
//   "For SREE DESIGN INFRASTRUCTURE PVT LTD"  ← teal, bold
//   [signature image]
//   ─────────────────────────────────────
//   Authorised Signatory                       ← dark, bold
//   (company seal positioned to the right)
//
// If anything fails the original buffer is returned unchanged so the upload
// never blocks on a stamping failure.

import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { COMPANY_SEAL_BASE64 } from "@/lib/seal-data";
import { COMPANY_SIGNATURE_BASE64 } from "@/lib/signature-data";

const MM = 2.8346; // points per millimetre

const TEAL = rgb(1 / 255, 94 / 255, 101 / 255);
const DARK = rgb(40 / 255, 40 / 255, 40 / 255);
const GREY = rgb(120 / 255, 120 / 255, 120 / 255);

export async function stampSignatureOnPdf(buffer: Buffer): Promise<Buffer> {
  try {
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pages = pdfDoc.getPages();
    const page = pages[pages.length - 1];
    const { width } = page.getSize();

    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const sigImage = await pdfDoc.embedPng(
      Buffer.from(COMPANY_SIGNATURE_BASE64.replace(/^data:image\/png;base64,/, ""), "base64"),
    );
    const sealImage = await pdfDoc.embedPng(
      Buffer.from(COMPANY_SEAL_BASE64.replace(/^data:image\/png;base64,/, ""), "base64"),
    );

    // Block anchor: bottom-right, 14mm from right edge, 20mm from bottom
    const marginRight = 14 * MM;
    const marginBottom = 20 * MM;
    const blockWidth = 90 * MM;
    const xLeft = width - marginRight - blockWidth;

    // Vertical layout (y=0 at page bottom, building bottom-up)
    const yASignatory = marginBottom;              // "Authorised Signatory" baseline
    const yRule = yASignatory + 4 * MM;           // horizontal rule
    const ySigBottom = yRule + 2 * MM;            // bottom of signature image
    const sigDims = sigImage.size();
    const sigH = 22 * MM;
    const sigW = sigH * (sigDims.width / sigDims.height);
    const ySigTop = ySigBottom + sigH;
    const yLabel = ySigTop + 3 * MM;             // "For SREE..." baseline

    page.drawText("For SREE DESIGN INFRASTRUCTURE PVT LTD", {
      x: xLeft,
      y: yLabel,
      size: 8,
      font: fontBold,
      color: TEAL,
    });

    page.drawImage(sigImage, {
      x: xLeft,
      y: ySigBottom,
      width: sigW,
      height: sigH,
    });

    page.drawLine({
      start: { x: xLeft, y: yRule },
      end: { x: xLeft + 68 * MM, y: yRule },
      thickness: 0.85, // ~0.3mm in points
      color: GREY,
    });

    page.drawText("Authorised Signatory", {
      x: xLeft,
      y: yASignatory,
      size: 8,
      font: fontBold,
      color: DARK,
    });

    // Seal: r=19mm, centred vertically in block, placed to the right of signature
    const sealR = 19 * MM;
    const sealCx = xLeft + sigW + 6 * MM + sealR;
    const sealCy = yASignatory + (yLabel - yASignatory) / 2;
    page.drawImage(sealImage, {
      x: sealCx - sealR,
      y: sealCy - sealR,
      width: sealR * 2,
      height: sealR * 2,
    });

    return Buffer.from(await pdfDoc.save());
  } catch (err) {
    console.warn("[stampSignatureOnPdf] failed, uploading original PDF:", err);
    return buffer;
  }
}
