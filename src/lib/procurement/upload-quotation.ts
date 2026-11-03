import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";

export interface QuotationUpload {
  file: File;
  vendor_name: string;
  /** As typed: the route parses it. */
  amount: string;
  notes?: string;
}

export type QuotationUploadResult = { ok: true } | { ok: false; error: string };

/** The three outside calls, replaceable in tests. */
export interface QuotationUploadDeps {
  fetchJson: typeof fetch;
  /** Uploads to the signed URL; returns an error message, or null on success. */
  uploadToSignedUrl: (path: string, token: string, file: File) => Promise<string | null>;
  prepare: (file: File) => Promise<File | null>;
}

const realDeps: QuotationUploadDeps = {
  fetchJson: (...args) => fetch(...args),
  uploadToSignedUrl: async (path, token, file) => {
    const { error } = await createBrowserClient()
      .storage.from("crm-documents")
      .uploadToSignedUrl(path, token, file, { contentType: file.type || "application/octet-stream" });
    return error ? error.message : null;
  },
  prepare: prepareUpload,
};

/**
 * Attaches a vendor quotation to an existing material request: the file goes straight to storage
 * through a signed URL (the API route never receives the file, which would hit Vercel's 4.5 MB
 * body limit) and the route then stores only its details. This is the same flow as adding a
 * quotation on the request page. Never throws: failures come back as a message to show.
 */
export async function uploadQuotation(prId: string, q: QuotationUpload, deps: QuotationUploadDeps = realDeps): Promise<QuotationUploadResult> {
  try {
    const prepared = await deps.prepare(q.file);
    if (!prepared) return { ok: false, error: "Upload cancelled" };

    const urlRes = await deps.fetchJson("/api/documents/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: prepared.name, mimeType: prepared.type, path: `material-requests/${prId}` }),
    });
    if (!urlRes.ok) return { ok: false, error: "Failed to get upload URL" };
    const { token, path: filePath } = await urlRes.json();

    const storageError = await deps.uploadToSignedUrl(filePath, token, prepared);
    if (storageError) return { ok: false, error: storageError };

    const res = await deps.fetchJson(`/api/procurement/requests/${prId}/quotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filePath,
        fileName: prepared.name,
        mimeType: prepared.type,
        vendor_name: q.vendor_name.trim(),
        amount: q.amount,
        notes: q.notes?.trim() || undefined,
      }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      return { ok: false, error: json?.error ?? res.statusText ?? "Failed to upload quotation" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof UploadTooLargeError || e instanceof Error ? e.message : "Failed to upload quotation" };
  }
}
