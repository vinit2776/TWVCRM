// Unified client-side entry point for every file upload in the app.
// Policy:
//   - Hard-reject files > HARD_MAX_BYTES (50 MB) with UploadTooLargeError.
//   - Images → compressImageClient (canvas, 2048px, JPEG Q82).
//   - PDFs   → normalizePdfClient  (pdf-lib metadata strip + object streams).
//   - If the processed file is still > SOFT_WARN_BYTES (15 MB), prompt the
//     user to confirm. If they decline, return null so the caller aborts.
//   - Otherwise return the processed File, ready for upload.

import { compressImageClient } from "./compress-image-client";
import { normalizePdfClient } from "./normalize-pdf-client";

export const HARD_MAX_BYTES = 50 * 1024 * 1024;
export const SOFT_WARN_BYTES = 15 * 1024 * 1024;

export class UploadTooLargeError extends Error {
  constructor(public readonly sizeBytes: number) {
    super(`File too large (${formatMB(sizeBytes)} MB). Maximum 50 MB per file. Please compress before uploading.`);
    this.name = "UploadTooLargeError";
  }
}

export async function prepareUpload(file: File): Promise<File | null> {
  if (file.size > HARD_MAX_BYTES) {
    throw new UploadTooLargeError(file.size);
  }

  let processed = file;
  if (file.type.startsWith("image/")) {
    processed = await compressImageClient(file);
  } else if (file.type === "application/pdf") {
    processed = await normalizePdfClient(file);
  }

  if (processed.size > SOFT_WARN_BYTES) {
    const proceed = await confirmLargeFile(processed.size);
    if (!proceed) return null;
  }

  return processed;
}

function formatMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function confirmLargeFile(sizeBytes: number): Promise<boolean> {
  if (typeof window === "undefined") return true;
  const msg =
    `This file is ${formatMB(sizeBytes)} MB after optimization. ` +
    `Large files upload slowly and may time out on mobile networks. ` +
    `Consider compressing it externally first.\n\n` +
    `Upload anyway?`;
  return window.confirm(msg);
}
