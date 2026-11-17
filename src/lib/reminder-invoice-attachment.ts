import type { SupabaseClient } from "@supabase/supabase-js";
import { buildProformaPdf } from "@/lib/proforma-pdf";

export interface ReminderAttachment {
  filename: string;
  content: Buffer;
  contentType: "application/pdf";
}

const safe = (ref: string) => ref.replace(/[\\/]/g, "-");

/**
 * The invoice PDF the customer is being chased for — the same document the
 * email names (see docNoun in sendOneReminder):
 *   • a GST invoice has been issued → the stored tax invoice PDF (Tally
 *     handoff upload first, then the legacy CRM-generated path);
 *   • otherwise → the proforma, rebuilt from stored data.
 *
 * Never falls back to the proforma once a tax invoice exists: that proforma is
 * superseded, and sending it would chase the customer for the wrong document.
 *
 * Returns null on any failure. A missing attachment must never stop the
 * reminder itself, so callers send without it and the email still carries the
 * amount and pay link.
 */
export async function fetchInvoiceAttachment(
  admin: SupabaseClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  statement: any,
): Promise<ReminderAttachment | null> {
  try {
    const gstNumber = (statement.gst_invoice_number as string | null) || null;
    if (gstNumber) {
      const { data: upload } = await admin
        .from("gst_invoice_uploads")
        .select("invoice_pdf_url, tally_invoice_number")
        .eq("billing_statement_id", statement.id)
        .is("superseded_by", null)
        .order("uploaded_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const path = (upload?.invoice_pdf_url as string | undefined)
        ?? (statement.gst_invoice_path as string | null)
        ?? null;
      if (!path) return null;
      const { data: blob, error } = await admin.storage.from("crm-documents").download(path);
      if (error || !blob) return null;
      const number = (upload?.tally_invoice_number as string | undefined) ?? gstNumber;
      return { filename: `Invoice-${safe(number)}.pdf`, content: Buffer.from(await blob.arrayBuffer()), contentType: "application/pdf" };
    }

    const r = await buildProformaPdf(admin, statement.id as string);
    if (!r.ok) return null;
    return { filename: r.filename, content: r.buffer, contentType: "application/pdf" };
  } catch (err) {
    console.error("[payment-reminder] invoice attachment failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
