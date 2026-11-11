"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { InvoiceCheckCard, type InvoiceCheckState } from "@/components/procurement/invoice-check-card";
import {
  buildInvoiceCheckRecord,
  checkInvoice,
  completeAmounts,
  type EnteredBill,
  type ExtractedInvoice,
  type InvoiceFinding,
  type SuggestionField,
} from "@/lib/procurement/invoice-check";
import { requestInvoiceExtraction } from "@/lib/procurement/invoice-extract-client";

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * The landlord's invoice for a new electricity bill: required, read once so what was typed can be
 * compared with what the invoice says, and kept with the bill so the approver sees any difference.
 * The comparison itself is advisory and never blocks saving.
 */
export function useLandlordInvoice(onRead?: (extracted: ExtractedInvoice) => void) {
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<InvoiceCheckState>({ status: "idle" });
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    if (picked.size > MAX_BYTES) {
      toast.error("File must be under 10 MB");
      e.target.value = "";
      return;
    }
    setFile(picked);
    const mine = ++seq.current;
    setCheck({ status: "loading" });
    requestInvoiceExtraction(picked).then((extracted) => {
      if (mine !== seq.current) return;
      setCheck(extracted ? { status: "ok", extracted } : { status: "unavailable" });
      if (extracted) onRead?.(extracted);
    });
  }, [onRead]);

  const clear = useCallback(() => {
    seq.current++;
    setCheck({ status: "idle" });
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  /** Uploads the chosen file; null (after a toast) when it fails. */
  const upload = useCallback(async (): Promise<string | null> => {
    if (!file) return null;
    const supabase = createBrowserClient();
    const ext = file.name.split(".").pop() ?? "pdf";
    const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error } = await supabase.storage.from("vendor-invoices").upload(path, file);
    if (error) {
      toast.error(`File upload failed: ${error.message}`);
      return null;
    }
    return supabase.storage.from("vendor-invoices").getPublicUrl(path).data.publicUrl;
  }, [file]);

  const findingsFor = (entered: EnteredBill): InvoiceFinding[] =>
    check.status === "ok" ? checkInvoice({ extracted: check.extracted, entered, poCeiling: null }) : [];

  const recordFor = (entered: EnteredBill) =>
    check.status === "ok" ? buildInvoiceCheckRecord(check.extracted, findingsFor(entered)) : null;

  return { file, check, inputRef, pick, clear, upload, findingsFor, recordFor };
}

/** GST rate worth switching on when the invoice prints GST; null when it shows none. */
export function gstRateFromInvoice(extracted: ExtractedInvoice): number | null {
  const { subtotal, gst } = completeAmounts(extracted);
  if (gst === null || gst <= 1) return null;
  if (subtotal === null || subtotal <= 0) return 18;
  const pct = Math.round((gst / subtotal) * 100);
  return pct > 0 && pct <= 40 ? pct : 18;
}

interface FieldProps {
  invoice: ReturnType<typeof useLandlordInvoice>;
  entered: EnteredBill;
  onApply: (field: SuggestionField, value: string) => void;
}

export function LandlordInvoiceField({ invoice, entered, onApply }: FieldProps) {
  const { file, check, inputRef, pick, clear } = invoice;
  const findings = invoice.findingsFor(entered);
  return (
    <div className="space-y-2">
      <Label>Landlord invoice <span className="text-red-500">*</span></Label>
      {file ? (
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
          <Paperclip className="h-4 w-4 text-muted-foreground" />
          <span className="truncate flex-1">{file.name}</span>
          <button type="button" onClick={clear} className="text-muted-foreground hover:text-destructive" aria-label="Remove invoice">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex w-full items-center justify-center gap-2 rounded-md border-2 border-dashed border-muted-foreground/25 px-4 py-4 text-sm text-muted-foreground hover:border-muted-foreground/50"
        >
          <Paperclip className="h-4 w-4" /> Upload the landlord&apos;s invoice — required, checked against your entries (PDF, JPG, PNG, max 10 MB)
        </button>
      )}
      <input ref={inputRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="sr-only" onChange={pick} />
      <InvoiceCheckCard state={check} entered={entered} poCeiling={null} onApply={onApply} />
      {findings.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-amber-800 rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          The invoice differs from what you entered in {findings.length} {findings.length === 1 ? "place" : "places"}. This is a guide only; you can still save, and the approver will see it.
        </p>
      )}
    </div>
  );
}
