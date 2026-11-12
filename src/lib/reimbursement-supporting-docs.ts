// Reimbursement supporting documents — fetch + merge helpers.
//
// Reimbursement statements (statement_type === "reimbursement") can have
// customer-facing supporting documents (receipts, vendor bills) attached at
// bill-customer time. This module fetches those rows and merges the actual
// files as extra pages onto the generated PI/GST invoice PDF, so the document
// that reaches the customer is self-contained.

import type { SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { IMAGE_MIME_TYPES, PDF_MIME_TYPE } from "@/lib/uploads/normalize-upload-server";

export interface SupportingDocRef {
  file_path: string;
  file_name: string;
  file_mime_type: string;
}

/** Fetches supporting-document rows for a billing statement. Returns [] if none. */
export async function fetchSupportingDocuments(
  adminSupabase: SupabaseClient,
  statementId: string
): Promise<SupportingDocRef[]> {
  const { data, error } = await adminSupabase
    .from("reimbursement_supporting_documents")
    .select("file_path, file_name, file_mime_type")
    .eq("billing_statement_id", statementId)
    .order("created_at", { ascending: true });

  if (error || !data) return [];
  return data as SupportingDocRef[];
}

const A4_WIDTH = 595.28; // points
const A4_HEIGHT = 841.89;
const PAGE_MARGIN = 28; // ~10mm

/**
 * Appends each supporting document as extra page(s) onto `baseBuffer`.
 * PDFs have their pages copied in directly. Images are re-encoded to JPEG via
 * sharp first (so pdf-lib's embedJpg always gets a format it supports,
 * regardless of the original upload's format — e.g. HEIC) then drawn onto a
 * single A4 page, centered and scaled to fit.
 *
 * Fails soft: a single corrupt/unreadable file is skipped (logged), never
 * thrown — one bad receipt must not block the invoice from being sent.
 * Returns `baseBuffer` unchanged when `docs` is empty.
 */
export async function mergeSupportingDocuments(
  adminSupabase: SupabaseClient,
  baseBuffer: Buffer<ArrayBuffer>,
  docs: SupportingDocRef[]
): Promise<Buffer<ArrayBuffer>> {
  if (docs.length === 0) return baseBuffer;

  const merged = await PDFDocument.create();
  const base = await PDFDocument.load(baseBuffer);
  const basePages = await merged.copyPages(base, base.getPageIndices());
  basePages.forEach((page) => merged.addPage(page));

  for (const doc of docs) {
    try {
      const { data, error } = await adminSupabase.storage
        .from("crm-documents")
        .download(doc.file_path);
      if (error || !data) {
        console.warn(`[reimbursement-supporting-docs] download failed for ${doc.file_path}:`, error?.message);
        continue;
      }
      const fileBuffer = Buffer.from(await data.arrayBuffer());

      if (doc.file_mime_type === PDF_MIME_TYPE) {
        const attachment = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });
        const pages = await merged.copyPages(attachment, attachment.getPageIndices());
        pages.forEach((page) => merged.addPage(page));
      } else if (IMAGE_MIME_TYPES.has(doc.file_mime_type)) {
        const jpegBuffer = await sharp(fileBuffer).rotate().jpeg({ quality: 85 }).toBuffer();
        const image = await merged.embedJpg(jpegBuffer);
        const page = merged.addPage([A4_WIDTH, A4_HEIGHT]);

        const maxW = A4_WIDTH - PAGE_MARGIN * 2;
        const maxH = A4_HEIGHT - PAGE_MARGIN * 2;
        const scale = Math.min(maxW / image.width, maxH / image.height, 1);
        const drawW = image.width * scale;
        const drawH = image.height * scale;

        page.drawImage(image, {
          x: (A4_WIDTH - drawW) / 2,
          y: (A4_HEIGHT - drawH) / 2,
          width: drawW,
          height: drawH,
        });
      } else {
        console.warn(`[reimbursement-supporting-docs] unsupported mime type, skipping: ${doc.file_mime_type}`);
      }
    } catch (err) {
      console.warn(`[reimbursement-supporting-docs] failed to merge ${doc.file_path}:`, err);
    }
  }

  return Buffer.from(await merged.save()) as Buffer<ArrayBuffer>;
}
