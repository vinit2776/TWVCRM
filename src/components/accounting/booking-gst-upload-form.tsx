"use client";

import { useMemo, useState } from "react";
import { Upload, Loader2, AlertCircle, Sparkles } from "lucide-react";
import { formatCurrency, preventEnterSubmit } from "@/lib/utils";
import type { ExtractResponse, AutofillSource } from "@/lib/tally-handoff";

interface Props {
  taskId: string;
  bookingNumber: string | null;
  spaceName: string | null;
  customerName: string | null;
  customerGstin: string | null;
  customerAddress: string | null;
  totalAmount: number;
  irnRequired: boolean;
  expectedSeries: string;
  expectedPrefix: string;
  onUploaded: (info: { invoiceNumber: string; amount: number; emailedTo: string | null }) => void;
  onCancel: () => void;
}

export function BookingGstUploadForm({
  taskId,
  bookingNumber,
  spaceName,
  customerName,
  customerGstin,
  customerAddress,
  totalAmount,
  irnRequired,
  expectedSeries,
  expectedPrefix,
  onUploaded,
  onCancel,
}: Props) {
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [irn, setIrn] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [invoiceAmount, setInvoiceAmount] = useState(String(totalAmount));
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [emailWarning, setEmailWarning] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [autofillSource, setAutofillSource] = useState<AutofillSource | null>(null);
  const [bridgeMatched, setBridgeMatched] = useState(false);
  const [autofilledFields, setAutofilledFields] = useState<Set<string>>(new Set());

  async function runAutofill(file: File) {
    setExtracting(true);
    setAutofillSource(null);
    setBridgeMatched(false);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/booking-gst-tasks/${taskId}/extract-gst-invoice`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        setAutofillSource("manual");
        return;
      }
      const data = (await res.json()) as ExtractResponse;
      const filled = new Set<string>();
      if (data.fields.invoice_number) { setInvoiceNumber(data.fields.invoice_number); filled.add("invoice_number"); }
      if (data.fields.irn) { setIrn(data.fields.irn); filled.add("irn"); }
      if (data.fields.invoice_date) { setInvoiceDate(data.fields.invoice_date); filled.add("invoice_date"); }
      if (data.fields.invoice_amount != null) { setInvoiceAmount(String(data.fields.invoice_amount)); filled.add("invoice_amount"); }
      setAutofilledFields(filled);
      setAutofillSource(data.source);
      setBridgeMatched(data.bridge_match);
    } catch {
      setAutofillSource("manual");
    } finally {
      setExtracting(false);
    }
  }

  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!invoiceNumber.trim()) errors.push("Tally invoice number is required.");
    if (invoiceNumber && !invoiceNumber.startsWith(expectedPrefix)) {
      errors.push(`Invoice number must start with "${expectedPrefix}" for this customer.`);
    }
    if (irnRequired && irn.trim().length > 0 && irn.trim().length !== 64) {
      errors.push("IRN must be exactly 64 characters if provided.");
    }
    if (!irnRequired && irn.trim().length > 0) {
      errors.push("B-series (non-GST customer) must NOT have an IRN.");
    }
    if (!invoiceDate) errors.push("Invoice date is required.");
    const amount = Number(invoiceAmount);
    if (!Number.isFinite(amount) || amount <= 0) errors.push("Invoice amount must be positive.");
    if (Math.round(amount) !== Math.round(Number(totalAmount))) {
      errors.push(`Amount ₹${amount} does not match booking total ₹${totalAmount}. Fix Tally or contact admin — no override.`);
    }
    if (!pdfFile) errors.push("Invoice PDF is required.");
    return errors;
  }, [invoiceNumber, irn, invoiceDate, invoiceAmount, pdfFile, irnRequired, expectedPrefix, totalAmount]);

  const canSubmit = validation.length === 0 && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !pdfFile) return;
    setSubmitting(true);
    setServerError(null);

    try {
      const formData = new FormData();
      formData.append("file", pdfFile);
      formData.append(
        "meta",
        JSON.stringify({
          tally_invoice_number: invoiceNumber.trim(),
          tally_invoice_series: expectedSeries,
          irn: irnRequired ? irn.trim() : null,
          invoice_date: invoiceDate,
          invoice_amount: Number(invoiceAmount),
          party_name_matches_contract: true,
          autofill_source: autofillSource ?? "manual",
          qr_payload: null,
          nic_signature_verified: false,
        }),
      );

      const res = await fetch(`/api/booking-gst-tasks/${taskId}/upload-gst-invoice`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const body = await res.json().catch(() => ({}));
      if (body.email_warning) {
        setEmailWarning(body.email_warning);
        setSubmitting(false);
        return;
      }

      onUploaded({
        invoiceNumber: invoiceNumber.trim(),
        amount: Number(invoiceAmount),
        emailedTo: body.emailed_to ?? null,
      });
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Upload failed");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="border-t bg-muted/30 p-4 space-y-3">
      <div className="text-sm">
        <div className="font-medium">Upload Tally GST invoice — Booking {bookingNumber ?? "—"}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Customer: <span className="font-medium">{customerName ?? "(walk-in)"}</span>
          {customerGstin ? ` · GSTIN ${customerGstin}` : " · (no GSTIN on file)"}
          {" · Expected series: "}
          <span className="font-mono">{expectedSeries}</span>
          {irnRequired && <span className="ml-2 text-blue-900">· IRN required</span>}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {customerAddress ? (
            <>Address: {customerAddress}</>
          ) : (
            <span className="text-amber-700">No address on file — check with the customer before raising the invoice.</span>
          )}
        </div>
      </div>

      <div className="rounded border bg-background p-3 text-xs space-y-1">
        <div className="font-medium text-foreground">Booking details</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
          <div><span className="text-muted-foreground">Booking #: </span><span className="font-mono">{bookingNumber ?? "—"}</span></div>
          {spaceName && <div><span className="text-muted-foreground">Space: </span>{spaceName}</div>}
          <div><span className="text-muted-foreground">Amount (GST incl.): </span><span className="font-medium">{formatCurrency(totalAmount)}</span></div>
        </div>
      </div>

      {(extracting || autofillSource) && (
        <div
          className={`text-xs rounded border p-2 flex items-start gap-1.5 ${
            extracting
              ? "bg-muted/50 border-muted-foreground/20 text-muted-foreground"
              : autofillSource === "manual"
                ? "bg-amber-50 border-amber-200 text-amber-900"
                : "bg-blue-50 border-blue-200 text-blue-900"
          }`}
        >
          {extracting ? (
            <><Loader2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 animate-spin" aria-hidden /><span>Reading PDF…</span></>
          ) : (
            <><Sparkles className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" aria-hidden />
              <span>
                {autofillSource === "pdf_text" && `Autofilled ${autofilledFields.size} field${autofilledFields.size === 1 ? "" : "s"} from PDF text.`}
                {autofillSource === "bridge_match" && "Matched against Tally voucher list."}
                {autofillSource === "manual" && "Could not auto-extract. Please fill the fields manually."}
                {bridgeMatched && " ✓ Bridge-verified in Tally."}
                {" "}<span className="text-muted-foreground">Review each value carefully before saving.</span>
              </span>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-xs">
          <span className="block mb-1 text-muted-foreground">
            Tally invoice number<span className="text-red-600">*</span>
          </span>
          <input
            type="text"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            placeholder={`${expectedPrefix}26-27/XXX`}
            className="w-full rounded border px-2 py-1.5 text-sm font-mono"
          />
        </label>

        <label className="text-xs">
          <span className="block mb-1 text-muted-foreground">Invoice date<span className="text-red-600">*</span></span>
          <input
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
            className="w-full rounded border px-2 py-1.5 text-sm"
          />
        </label>

        <label className="text-xs">
          <span className="block mb-1 text-muted-foreground">Invoice amount (₹)<span className="text-red-600">*</span></span>
          <input
            type="number"
            value={invoiceAmount}
            onChange={(e) => setInvoiceAmount(e.target.value)}
            step="0.01"
            min="0"
            className="w-full rounded border px-2 py-1.5 text-sm font-mono"
          />
          <span className="text-muted-foreground text-[11px]">Expected: {formatCurrency(totalAmount)}</span>
        </label>

        {irnRequired && (
          <label className="text-xs">
            <span className="block mb-1 text-muted-foreground">IRN (64 chars, optional for exemptions)</span>
            <input
              type="text"
              value={irn}
              onChange={(e) => setIrn(e.target.value.trim())}
              placeholder="abc123…"
              maxLength={64}
              className="w-full rounded border px-2 py-1.5 text-sm font-mono"
            />
          </label>
        )}
      </div>

      <label className="text-xs block">
        <span className="block mb-1 text-muted-foreground">Invoice PDF<span className="text-red-600">*</span></span>
        <input
          type="file"
          accept=".pdf,image/png,image/jpeg"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setPdfFile(f);
            if (f && f.type === "application/pdf") void runAutofill(f);
          }}
          className="w-full text-xs"
        />
      </label>

      {serverError && (
        <div className="text-xs text-red-700 flex items-start gap-1">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" aria-hidden />
          <span>{serverError}</span>
        </div>
      )}

      {emailWarning && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 space-y-2">
          <div className="flex items-start gap-1.5">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" aria-hidden />
            <span><strong>Invoice saved, but email not sent:</strong> {emailWarning}</span>
          </div>
          <p>Use the <strong>Save &amp; send</strong> button on the row to retry email delivery.</p>
        </div>
      )}

      {validation.length > 0 && (invoiceNumber || irn || pdfFile) && (
        <ul className="text-xs text-red-700 space-y-0.5">
          {validation.map((e) => <li key={e}>· {e}</li>)}
        </ul>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-foreground text-background hover:opacity-90 disabled:opacity-40"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {submitting ? "Saving…" : "Save invoice"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded border hover:bg-muted"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
