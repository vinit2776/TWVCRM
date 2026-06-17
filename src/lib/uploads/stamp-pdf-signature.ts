// Server-side utility: overlays the company signature image and seal onto the
// bottom-right of the last page of a PDF using pdf-lib.
//
// Tally PDFs already print the full signatory block text ("For Sree Design
// Infrastructure Pvt Ltd", the rule, and "Authorised Signatory"). This overlay
// adds only the signature PNG and company seal PNG into the blank space that
// Tally leaves for them — no text or lines are drawn.
//
// If anything fails the original buffer is returned unchanged so the upload
// never blocks on a stamping failure.

import { PDFDocument } from "pdf-lib";
import { COMPANY_SEAL_BASE64 } from "@/lib/seal-data";
import { COMPANY_SIGNATURE_BASE64 } from "@/lib/signature-data";

const MM = 2.8346; // points per millimetre

export async function stampSignatureOnPdf(buffer: Buffer): Promise<Buffer> {
  try {
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pages = pdfDoc.getPages();
    const page = pages[pages.length - 1];
    const { width } = page.getSize();

    const sigImage = await pdfDoc.embedPng(
      Buffer.from(COMPANY_SIGNATURE_BASE64.replace(/^data:image\/png;base64,/, ""), "base64"),
    );
    const sealImage = await pdfDoc.embedPng(
      Buffer.from(COMPANY_SEAL_BASE64.replace(/^data:image\/png;base64,/, ""), "base64"),
    );

    // Anchor: same bottom-right position as before so the images land inside
    // the blank signature space that Tally reserves in its signatory block.
    const marginRight = 14 * MM;
    const marginBottom = 20 * MM;
    const blockWidth = 90 * MM;
    const xLeft = width - marginRight - blockWidth;

    // Signature image sits in the blank space between Tally's "For Sree..."
    // label and its printed rule + "Authorised Signatory" line.
    // ySigBottom is calculated the same way as before so the image stays aligned.
    const ySigBottom = marginBottom + 6 * MM; // 26 mm from page bottom
    const sigDims = sigImage.size();
    const sigH = 22 * MM;
    const sigW = sigH * (sigDims.width / sigDims.height);

    page.drawImage(sigImage, {
      x: xLeft,
      y: ySigBottom,
      width: sigW,
      height: sigH,
    });

    // Seal: r=19mm, vertically centred on the signature image, to its right
    const sealR = 19 * MM;
    const sealCx = xLeft + sigW + 6 * MM + sealR;
    const sealCy = ySigBottom + sigH / 2;
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
