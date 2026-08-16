import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { normalizeUploadServer, UploadValidationError } from "@/lib/uploads/normalize-upload-server";
import { MAX_ATTACHMENTS_PER_MESSAGE, type QueryAttachment } from "./types";

/**
 * Server-side attachment handling for query messages.
 *
 * Both POST /api/queries and POST /api/queries/[id]/messages accept either
 * JSON (no files) or multipart/form-data (a `meta` JSON part plus one or more
 * `file` parts) — the same shape the credit-note and GST uploads use. Keeping
 * the JSON path means every existing caller and the no-attachment case stay
 * on the cheaper route.
 */

export const ATTACHMENT_BUCKET = "crm-documents";

export interface ParsedPayload<T> {
  meta: T;
  files: File[];
}

/**
 * Read a request as either JSON or multipart. Throws UploadValidationError on
 * anything malformed so routes can map it to a 400 uniformly.
 */
export async function parseQueryRequest<T>(req: NextRequest): Promise<ParsedPayload<T>> {
  const contentType = req.headers.get("content-type") ?? "";

  if (!contentType.includes("multipart/form-data")) {
    const meta = (await req.json().catch(() => ({}))) as T;
    return { meta, files: [] };
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new UploadValidationError("Could not read the uploaded form data.");
  }

  const metaRaw = form.get("meta");
  let meta: T;
  try {
    meta = (typeof metaRaw === "string" ? JSON.parse(metaRaw) : {}) as T;
  } catch {
    throw new UploadValidationError("Invalid meta JSON.");
  }

  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new UploadValidationError(
      `Too many attachments (${files.length}). Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} per message.`,
    );
  }

  return { meta, files };
}

/**
 * Normalize, store and record the files attached to one message.
 *
 * Deliberately best-effort *per file* rather than transactional: the message
 * is already saved by the time this runs, and losing a reply because one
 * screenshot failed to upload would be worse than a reply with a missing
 * attachment. Failures are logged and reported back so the route can tell the
 * user which ones didn't make it.
 */
export async function storeAttachments(
  admin: SupabaseClient,
  params: { queryId: string; messageId: string; files: File[]; uploadedBy: string },
): Promise<{ stored: number; failed: string[] }> {
  const failed: string[] = [];
  let stored = 0;

  for (const file of params.files) {
    try {
      const normalized = await normalizeUploadServer(file);

      // normalizeUploadServer re-encodes images to JPEG, so the original
      // extension is a lie by the time we store it — a file called .png that
      // is actually a JPEG confuses anything that trusts the name. Rebuild
      // the display name on the extension we actually produced.
      const baseName = (file.name || "attachment")
        .replace(/\.[^.]+$/, "")
        .replace(/[^\w.-]/g, "_")
        .slice(0, 80) || "attachment";
      const safeName = `${baseName}.${normalized.ext}`;
      // Timestamp-prefixed so two people attaching "screenshot.png" to the
      // same thread don't collide.
      const filePath = `queries/${params.queryId}/${Date.now()}-${safeName}`;

      const { error: uploadErr } = await admin.storage
        .from(ATTACHMENT_BUCKET)
        .upload(filePath, normalized.buffer, { contentType: normalized.mimeType });

      if (uploadErr) {
        console.error("[query attachment] upload failed:", uploadErr.message);
        failed.push(file.name);
        continue;
      }

      const { error: insertErr } = await admin.from("query_attachments").insert({
        message_id: params.messageId,
        file_path: filePath,
        file_name: safeName,
        file_mime_type: normalized.mimeType,
        size_bytes: normalized.finalBytes,
        uploaded_by: params.uploadedBy,
      });

      if (insertErr) {
        console.error("[query attachment] insert failed:", insertErr.message);
        failed.push(file.name);
        continue;
      }

      stored++;
    } catch (err) {
      const message = err instanceof UploadValidationError ? err.message : "could not be processed";
      console.error("[query attachment] rejected:", file.name, message);
      failed.push(file.name);
    }
  }

  return { stored, failed };
}

/** Select fragment for reading a message's attachments alongside it. */
export const ATTACHMENT_SELECT = "id, file_name, file_mime_type, size_bytes";

export function toAttachment(row: unknown): QueryAttachment {
  const r = row as { id: string; file_name: string; file_mime_type: string; size_bytes: number | null };
  return {
    id: r.id,
    file_name: r.file_name,
    file_mime_type: r.file_mime_type,
    size_bytes: r.size_bytes,
  };
}
