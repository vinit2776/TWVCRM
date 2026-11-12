/**
 * DRAFT watermarking for agreement PDFs.
 *
 * An unstamped Leave & License agreement looks identical to the final one,
 * so a copy pulled off the Documents tab mid-flow can be mistaken for the
 * executed instrument. Every hand-out of an unstamped agreement — download,
 * view, preview, email attachment — is watermarked so that cannot happen.
 *
 * The watermark is applied at HAND-OUT, never at generation. The stored PDF
 * stays pristine on purpose: `leave-license/sign` downloads that exact file
 * and sends it to Leegality for e-signature, and `manual-sign` uploads a
 * countersigned copy of it. Watermarking at generation would put "DRAFT"
 * permanently on legally executed agreements.
 */
import { PDFDocument, rgb, degrees, StandardFonts } from "pdf-lib";

/**
 * Overlays a diagonal DRAFT watermark across every page.
 *
 * Returns the original bytes unchanged if the PDF cannot be parsed — a
 * watermark is a safeguard, and failing to apply one must not break the
 * download it was protecting.
 */
export async function applyDraftWatermark(pdfBytes: Uint8Array | Buffer): Promise<Uint8Array> {
  try {
    const pdf = await PDFDocument.load(pdfBytes as Uint8Array, { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.HelveticaBold);
    const text = "DRAFT";

    for (const page of pdf.getPages()) {
      const { width, height } = page.getSize();
      // Size the word to span most of the diagonal, whatever the page format.
      const size = Math.min(width, height) * 0.28;
      const textWidth = font.widthOfTextAtSize(text, size);
      const angle = 45;
      const rad = (angle * Math.PI) / 180;

      // Centre the rotated baseline on the page.
      const x = width / 2 - (textWidth / 2) * Math.cos(rad);
      const y = height / 2 - (textWidth / 2) * Math.sin(rad);

      page.drawText(text, {
        x,
        y,
        size,
        font,
        color: rgb(0.55, 0.6, 0.62),
        opacity: 0.18,
        rotate: degrees(angle),
      });
    }

    return await pdf.save();
  } catch (err) {
    console.error("[draft-watermark] could not watermark PDF, serving it unmarked:", err);
    return pdfBytes instanceof Buffer ? new Uint8Array(pdfBytes) : pdfBytes;
  }
}

/**
 * Whether an agreement's PDF should go out marked DRAFT.
 *
 * Final means the company stamp and seal have been applied, or the agreement
 * has otherwise reached execution (Leegality e-sign, or a countersigned copy
 * uploaded manually) — all three record a signed document against the row.
 */
export function isDraftAgreement(agreement: {
  status?: string | null;
  signed_document_id?: string | null;
  stamp_reference?: string | null;
} | null | undefined): boolean {
  if (!agreement) return true;
  if (agreement.signed_document_id) return false;
  if (agreement.stamp_reference) return false;
  return agreement.status !== "executed";
}
