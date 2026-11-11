"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  // Differences left open on purpose: allowed only with a reason, which is kept with the bill.
  const [overrideReason, setOverrideReason] = useState("");
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
    setOverrideReason("");
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
    check.status === "ok" ? buildInvoiceCheckRecord(check.extracted, findingsFor(entered), overrideReason) : null;

  /** null when the bill may be saved; otherwise what is in the way. */
  const blockedReason = (entered: EnteredBill, duplicate: string | null = null): string | null => {
    if (!entered.invoiceNumber.trim()) return "Enter the bill number — it is printed on the landlord's invoice";
    if (duplicate) return duplicate;
    if (check.status === "loading") return "Still reading the invoice — wait a moment";
    if (findingsFor(entered).length > 0 && overrideReason.trim().length < 5) {
      return "What you entered doesn't match the invoice. Correct it, or explain the difference below";
    }
    return null;
  };

  return { file, check, inputRef, pick, clear, upload, findingsFor, recordFor, blockedReason, overrideReason, setOverrideReason };
}

/** Warns as soon as a bill number is known if that bill is already on file. */
export function useDuplicateWarning(locationId: string, billNumber: string): string | null {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    const number = billNumber.trim();
    if (!locationId || !number) { setMessage(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      fetch(`/api/electricity-bills/duplicate-check?location_id=${encodeURIComponent(locationId)}&bill_number=${encodeURIComponent(number)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (live) setMessage(j?.duplicate?.message ?? null); })
        .catch(() => { if (live) setMessage(null); });
    }, 500);
    return () => { live = false; clearTimeout(timer); };
  }, [locationId, billNumber]);
  return message;
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
  duplicate?: string | null;
  entered: EnteredBill;
  onApply: (field: SuggestionField, value: string) => void;
}

export function LandlordInvoiceField({ invoice, duplicate, entered, onApply }: FieldProps) {
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
      {duplicate && (
        <p className="flex items-start gap-1.5 text-xs text-red-800 rounded border border-red-200 bg-red-50 px-2.5 py-1.5">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          {duplicate}
        </p>
      )}
      <InvoiceCheckCard state={check} entered={entered} poCeiling={null} onApply={onApply} />
      {findings.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-amber-800 rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          What you entered differs from the invoice in {findings.length} {findings.length === 1 ? "place" : "places"}. Correct it to match, or — only if the invoice is the one that is wrong — explain why below. The approver will see this.
        </p>
      )}
      {findings.length > 0 && (
        <Textarea
          value={invoice.overrideReason}
          onChange={(e) => invoice.setOverrideReason(e.target.value)}
          placeholder="Only if the differences are correct: why? (required to save with differences)"
          rows={2}
          className="text-sm"
        />
      )}
      {check.status === "unavailable" && file && (
        <p className="text-xs text-muted-foreground">The invoice could not be read automatically — compare it with your entries by eye before saving.</p>
      )}
    </div>
  );
}
