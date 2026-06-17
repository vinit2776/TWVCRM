// Server-side utility: overlays the company signature image and seal onto the
// last page of a Tally GST invoice PDF.
//
// The stamp is anchored to the "For Sree Design Infrastructure Pvt Ltd" text
// that Tally already prints — we find that text's coordinates via pdf-parse,
// then draw the signature image immediately below it and the seal beside it.
// No text or lines are drawn by us; Tally already handles those.
//
// If text detection fails a hardcoded bottom-right fallback is used.
// Any pdf-lib error returns the original buffer unchanged.

import { PDFDocument } from "pdf-lib";
import pdfParse from "pdf-parse";
import { COMPANY_SEAL_BASE64 } from "@/lib/seal-data";
import { COMPANY_SIGNATURE_BASE64 } from "@/lib/signature-data";

const MM = 2.8346; // 1 mm in points

// pdf-parse internal page item shape
interface PdfItem {
  str: string;
  transform: number[]; // [scaleX, skewY, skewX, scaleY, x, y]
}

/** Finds the bottom-left coordinate of the "For Sree Design…" label in the PDF. */
async function findSignatoryAnchor(
  buffer: Buffer,
): Promise<{ x: number; y: number } | null> {
  const SEARCH = [
    "for sree design infrastructure pvt ltd",
    "for sree design infrastructure",
    "sree design infrastructure pvt",
    "sree design infrastructure",
  ];

  let anchor: { x: number; y: number } | null = null;

  try {
    await pdfParse(buffer, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pagerender: async (pageData: any) => {
        const content = await pageData.getTextContent() as { items: PdfItem[] };
        for (const item of content.items) {
          const text = item.str.toLowerCase().trim();
          if (SEARCH.some((s) => text.includes(s))) {
            anchor = { x: item.transform[4], y: item.transform[5] };
          }
        }
        return "";
      },
    });
  } catch {
    // non-fatal — fall through to null
  }

  return anchor;
}

export async function stampSignatureOnPdf(buffer: Buffer): Promise<Buffer> {
  try {
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pages = pdfDoc.getPages();
    const page = pages[pages.length - 1];
    const { width } = page.getSize();

    const sigImage = await pdfDoc.embedPng(
      Buffer.from(
        COMPANY_SIGNATURE_BASE64.replace(/^data:image\/png;base64,/, ""),
        "base64",
      ),
    );
    const sealImage = await pdfDoc.embedPng(
      Buffer.from(
        COMPANY_SEAL_BASE64.replace(/^data:image\/png;base64,/, ""), "base64",
      ),
    );

    // Scale signature image to 20mm tall, preserve aspect ratio
    const sigH = 20 * MM;
    const sigDims = sigImage.size();
    const sigW = sigH * (sigDims.width / sigDims.height);

    // Try to locate the "For Sree Design…" text printed by Tally
    const anchor = await findSignatoryAnchor(buffer);

    let xLeft: number;
    let ySigTop: number; // top of signature image (y=0 at page bottom)

    if (anchor) {
      // Place signature immediately below the detected text.
      // anchor.y is the text baseline; subtract a 1 mm gap then the image height.
      xLeft = anchor.x;
      ySigTop = anchor.y - 1 * MM;
    } else {
      // Fallback: bottom-right corner, 14 mm from right, 46 mm from bottom
      xLeft = width - 14 * MM - 80 * MM;
      ySigTop = 46 * MM;
    }

    const ySigBottom = ySigTop - sigH;

    page.drawImage(sigImage, {
      x: xLeft,
      y: ySigBottom,
      width: sigW,
      height: sigH,
    });

    // Seal: r=12mm, placed to the right of the signature, vertically centred on it
    const sealR = 12 * MM;
    const sealCx = xLeft + sigW + 4 * MM + sealR;
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
