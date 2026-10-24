import { PDFDocument } from "pdf-lib";
import { generateElectricityAnnexurePDF, type GstInvoiceData } from "@/lib/gst-invoice-generator";

/**
 * Appends the frozen Annexure A page to an uploaded (Tally-issued) invoice PDF.
 * Returns the input untouched when there is no annexure or anything fails —
 * the upload must never be blocked by the annexure.
 */
export async function appendElectricityAnnexure(
  base: Buffer,
  data: Pick<GstInvoiceData, "invoiceNumber" | "contractNumber" | "annexure">,
): Promise<Buffer> {
  if (!data.annexure) return base;
  try {
    const annexurePdf = await PDFDocument.load(generateElectricityAnnexurePDF(data));
    const merged = await PDFDocument.load(base, { ignoreEncryption: true });
    const pages = await merged.copyPages(annexurePdf, annexurePdf.getPageIndices());
    pages.forEach((p) => merged.addPage(p));
    return Buffer.from(await merged.save());
  } catch (err) {
    console.error("[electricity-annexure] append failed; uploading PDF unchanged", err instanceof Error ? err.message : err);
    return base;
  }
}
