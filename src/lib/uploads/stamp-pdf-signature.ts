// Server-side utility: overlays the company signature image and seal onto the
// last page of a Tally GST invoice PDF.
//
// Strategy: find "Authorised Signatory" text that Tally already prints, then
// place the signature image just ABOVE it (inside the signatory box). The seal
// sits to the right of the signature. No text or lines are drawn by us.
//
// If text detection fails a hardcoded position is used as fallback.
// Any pdf-lib error returns the original buffer unchanged.

import { PDFDocument } from "pdf-lib";
import { COMPANY_SEAL_BASE64 } from "@/lib/seal-data";
import { COMPANY_SIGNATURE_BASE64 } from "@/lib/signature-data";

const MM = 2.8346; // 1 mm in points

interface PdfItem {
  str: string;
  transform: number[]; // [scaleX, skewY, skewX, scaleY, x, y]
}

interface TextAnchors {
  authSignatory: { x: number; y: number } | null;
  companyName: { x: number; y: number } | null;
}

async function findTextAnchors(buffer: Buffer): Promise<TextAnchors> {
  const AUTH_TERMS = ["authorised signatory", "authorized signatory"];
  const COMPANY_TERMS = [
    "for sree design infrastructure pvt ltd",
    "for sree design infrastructure",
    "sree design infrastructure pvt",
    "sree design infrastructure",
  ];

  const result: TextAnchors = { authSignatory: null, companyName: null };

  try {
    // Dynamic import avoids pdf-parse reading its test fixture at module load
    // time, which crashes the Next.js build (same pattern as tally-pdf-extract.ts).
    const { default: pdfParse } = (await import("pdf-parse")) as unknown as {
      default: (buf: Buffer, opts: Record<string, unknown>) => Promise<unknown>;
    };
    await pdfParse(buffer, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pagerender: async (pageData: any) => {
        const content = await pageData.getTextContent() as { items: PdfItem[] };
        for (const item of content.items) {
          const text = item.str.toLowerCase().trim();
          if (AUTH_TERMS.some((t) => text.includes(t))) {
            result.authSignatory = { x: item.transform[4], y: item.transform[5] };
          }
          if (COMPANY_TERMS.some((t) => text.includes(t))) {
            result.companyName = { x: item.transform[4], y: item.transform[5] };
          }
        }
        return "";
      },
    });
  } catch {
    // non-fatal
  }

  return result;
}

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

    const sigH = 20 * MM;
    const sigDims = sigImage.size();
    const sigW = sigH * (sigDims.width / sigDims.height);

    const anchors = await findTextAnchors(buffer);

    let xLeft: number;
    let ySigBottom: number;

    if (anchors.authSignatory) {
      // Primary: place signature directly above "Authorised Signatory".
      // authSignatory.y is the text baseline (y=0 at page bottom in PDF coords).
      // We add 3mm gap above the baseline to clear the text ascenders.
      const auth = anchors.authSignatory;
      ySigBottom = auth.y + 3 * MM;
      // X: align with the company name if found, otherwise match auth signatory x
      xLeft = anchors.companyName?.x ?? auth.x;
    } else if (anchors.companyName) {
      // Fallback: place signature just below the company name text.
      const co = anchors.companyName;
      xLeft = co.x;
      // co.y is company name baseline; signature top sits 1mm below it
      ySigBottom = co.y - 1 * MM - sigH;
    } else {
      // Last resort: fixed position in the bottom-right signatory area
      xLeft = width - 14 * MM - 80 * MM;
      ySigBottom = 55 * MM; // ~55mm from page bottom
    }

    page.drawImage(sigImage, {
      x: xLeft,
      y: ySigBottom,
      width: sigW,
      height: sigH,
    });

    // Seal: r=12mm, to the right of the signature, vertically centred on it
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
