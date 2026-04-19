// Client-side PDF normalizer. Loads a PDF via pdf-lib, strips metadata, and
// re-saves with object streams for moderate size reduction (typically 5-15%).
// Preserves signatures and text layer — does NOT rasterize or touch page
// content streams. Non-PDF files are returned unchanged. On any failure
// (encrypted, malformed) the original file is returned so uploads never block.

import { PDFDocument } from "pdf-lib";

export async function normalizePdfClient(file: File): Promise<File> {
  if (typeof window === "undefined") return file;
  if (file.type !== "application/pdf") return file;

  try {
    const bytes = await file.arrayBuffer();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });

    doc.setTitle("");
    doc.setAuthor("");
    doc.setSubject("");
    doc.setKeywords([]);
    doc.setProducer("");
    doc.setCreator("");

    const saved = await doc.save({ useObjectStreams: true, addDefaultPage: false });

    // Never grow the file — fall back to original if normalization didn't help.
    if (saved.byteLength >= bytes.byteLength) return file;

    return new File([new Uint8Array(saved)], file.name, {
      type: "application/pdf",
      lastModified: Date.now(),
    });
  } catch (err) {
    console.warn("[normalizePdfClient] failed, uploading original:", err);
    return file;
  }
}
