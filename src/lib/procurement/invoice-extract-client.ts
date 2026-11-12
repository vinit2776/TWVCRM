import type { ExtractedInvoice } from "@/lib/procurement/invoice-check";

/** Browser-side call to the read-only extract route. Resolves to null on any failure. */
export async function requestInvoiceExtraction(file: File, opts: { lines?: boolean } = {}): Promise<ExtractedInvoice | null> {
  try {
    const fd = new FormData();
    fd.append("file", file);
    if (opts.lines) fd.append("mode", "lines");
    const res = await fetch("/api/procurement/bills/extract", { method: "POST", body: fd });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.status === "ok" && json.extracted ? (json.extracted as ExtractedInvoice) : null;
  } catch {
    return null;
  }
}
