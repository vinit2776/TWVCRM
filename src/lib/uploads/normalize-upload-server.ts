// Server-side normalizer. Runs on every upload handled by a Next.js API route.
// Images are re-encoded via sharp (auto-rotate, max 2048px, JPEG Q82 mozjpeg).
// PDFs pass through unchanged — they were already normalized client-side by
// prepareUpload() before being sent. Unsupported MIME types throw.
// This is defense-in-depth; the client-side pipeline is the primary defense.

import sharp from "sharp";

export const HARD_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_DIMENSION = 2048;
export const JPEG_QUALITY = 82;

export const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export const PDF_MIME_TYPE = "application/pdf";

export class UploadValidationError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = "UploadValidationError";
  }
}

export type NormalizedUpload = {
  buffer: Buffer;
  mimeType: string;
  ext: string;
  originalBytes: number;
  finalBytes: number;
};

export type NormalizeOptions = {
  /** Allowed MIME types in addition to images and PDF (e.g. docx/doc for tickets). */
  extraMimeTypes?: Set<string>;
  /** Override the default 50 MB hard cap (rare — prefer the default). */
  maxBytes?: number;
};

export async function normalizeUploadServer(
  file: File,
  opts: NormalizeOptions = {}
): Promise<NormalizedUpload> {
  const maxBytes = opts.maxBytes ?? HARD_MAX_BYTES;
  if (file.size > maxBytes) {
    throw new UploadValidationError(
      `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum ${Math.round(maxBytes / 1024 / 1024)} MB per file.`
    );
  }

  const extraAllowed = opts.extraMimeTypes ?? new Set<string>();
  const isImage = IMAGE_MIME_TYPES.has(file.type);
  const isPdf = file.type === PDF_MIME_TYPE;
  const isExtra = extraAllowed.has(file.type);

  if (!isImage && !isPdf && !isExtra) {
    throw new UploadValidationError(
      `Unsupported file type: ${file.type || "unknown"}`
    );
  }

  const originalBytes = file.size;
  const raw = Buffer.from(await file.arrayBuffer());

  if (isImage) {
    const processed = await sharp(raw)
      .rotate()
      .resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    return {
      buffer: processed,
      mimeType: "image/jpeg",
      ext: "jpg",
      originalBytes,
      finalBytes: processed.length,
    };
  }

  if (isPdf) {
    return {
      buffer: raw,
      mimeType: PDF_MIME_TYPE,
      ext: "pdf",
      originalBytes,
      finalBytes: raw.length,
    };
  }

  // Pass-through for extra-allowed types (e.g. docx, doc).
  const ext = file.name.split(".").pop()?.toLowerCase() || "bin";
  return {
    buffer: raw,
    mimeType: file.type,
    ext,
    originalBytes,
    finalBytes: raw.length,
  };
}
