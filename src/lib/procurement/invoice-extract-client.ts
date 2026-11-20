import type { ExtractedInvoice } from "@/lib/procurement/invoice-check";
import {
  MAX_CHECK_UPLOAD_BYTES,
  isInvoiceCheckReason,
  reasonFromHttpStatus,
  type InvoiceCheckReason,
} from "@/lib/procurement/invoice-check-reasons";

export type InvoiceExtractionResult =
  | { ok: true; extracted: ExtractedInvoice }
  | { ok: false; reason: InvoiceCheckReason };

/** Browser-side call to the read-only extract route. Never throws; failures carry a reason. */
export async function requestInvoiceExtraction(file: File): Promise<InvoiceExtractionResult> {
  // Vercel rejects bodies over ~4.5 MB with a non-JSON 413 before the route runs.
  if (file.size > MAX_CHECK_UPLOAD_BYTES) return { ok: false, reason: "too_large" };
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/procurement/bills/extract", { method: "POST", body: fd });
    const json = await res.json().catch(() => null);
    if (res.ok && json?.status === "ok" && json.extracted) {
      return { ok: true, extracted: json.extracted as ExtractedInvoice };
    }
    const reason = isInvoiceCheckReason(json?.reason) ? json.reason : reasonFromHttpStatus(res.status);
    return { ok: false, reason };
  } catch {
    return { ok: false, reason: "service_error" };
  }
}
