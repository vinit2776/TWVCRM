"use client";

/**
 * Inline upload form for the Accounts Inbox.
 *
 * Renders inside an expanded inbox row when the row's handoff_state is
 * `pi_paid_awaiting_gst` or `direct_gst_requested`. Manual entry for now —
 * the QR / PDF / bridge autofill cascade ships in PR #4.
 *
 * Hard-block rules are mirrored client-side (helpful UX) AND enforced
 * server-side (the source of truth). Don't trust the client.
 */

import { useMemo, useState } from "react";
import { Upload, Loader2, AlertCircle, Sparkles } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import type { InboxRow, ExtractResponse, AutofillSource } from "@/lib/tally-handoff";

interface Props {
  row: InboxRow;
  onUploaded: () => void;
  onCancel: () => void;
}

export function TallyInboxUploadForm({ row, onUploaded, onCancel }: Props) {
  const lead = row.contract?.lead;
  const customerHasGstin = !!lead?.gst_number;
  const expectedSeries = customerHasGstin ? "SDIPL-REG" : "SDIPL-UNREG";
  const expectedPrefix = customerHasGstin ? "SD/A/" : "SD/B/";
  const partyName =
    lead?.company || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "(unnamed)";

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [irn, setIrn] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [invoiceAmount, setInvoiceAmount] = useState(String(row.statement_total_amount));
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [nameMatches, setNameMatches] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
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
      const res = await fetch(`/api/billing-statements/${row.statement_id}/extract-gst-invoice`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        // Autofill failure is non-fatal — accounts can still type manually.
        setAutofillSource("manual");
        return;
      }
      const data = (await res.json()) as ExtractResponse;
      const filled = new Set<string>();
      if (data.fields.invoice_number) {
        setInvoiceNumber(data.fields.invoice_number);
        filled.add("invoice_number");
      }
      if (data.fields.irn) {
        setIrn(data.fields.irn);
        filled.add("irn");
      }
      if (data.fields.invoice_date) {
        setInvoiceDate(data.fields.invoice_date);
        filled.add("invoice_date");
      }
      if (data.fields.invoice_amount != null) {
        setInvoiceAmount(String(data.fields.invoice_amount));
        filled.add("invoice_amount");
      }
      setAutofilledFields(filled);
      setAutofillSource(data.source);
      setBridgeMatched(data.bridge_match);
    } catch {
      setAutofillSource("manual");
    } finally {
      setExtracting(false);
    }
  }

  // ── Client-side validation (mirrors server's hard-blocks) ─────────────────
  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!invoiceNumber.trim()) errors.push("Tally invoice number is required.");
    if (invoiceNumber && !invoiceNumber.startsWith(expectedPrefix)) {
      errors.push(`Invoice number must start with "${expectedPrefix}" for this customer.`);
    }
    if (customerHasGstin && irn.trim().length !== 64) {
      errors.push("A-series (GST customer) requires a 64-character IRN.");
    }
    if (!customerHasGstin && irn.trim().length > 0) {
      errors.push("B-series (non-GST customer) must NOT have an IRN.");
    }
    if (!invoiceDate) errors.push("Invoice date is required.");
    const amount = Number(invoiceAmount);
    if (!Number.isFinite(amount) || amount <= 0) errors.push("Invoice amount must be positive.");
    if (amount.toFixed(2) !== Number(row.statement_total_amount).toFixed(2)) {
      errors.push(
        `Amount ₹${amount} does not match statement total ₹${row.statement_total_amount}. Fix Tally or void+reissue — no override.`,
      );
    }
    if (!pdfFile) errors.push("Invoice PDF is required.");
    return errors;
  }, [invoiceNumber, irn, invoiceDate, invoiceAmount, pdfFile, customerHasGstin, expectedPrefix, row.statement_total_amount]);

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
          irn: customerHasGstin ? irn.trim() : null,
          invoice_date: invoiceDate,
          invoice_amount: Number(invoiceAmount),
          party_name_matches_contract: nameMatches,
          autofill_source: autofillSource ?? "manual",
          qr_payload: null,
          nic_signature_verified: false,
        }),
      );

      const res = await fetch(`/api/billing-statements/${row.statement_id}/upload-gst-invoice`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      onUploaded();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Upload failed");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="border-t bg-muted/30 p-4 space-y-3">
      <div className="text-sm">
        <div className="font-medium">Upload Tally GST invoice</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Customer: <span className="font-medium">{partyName}</span>
          {lead?.gst_number ? ` · GSTIN ${lead.gst_number}` : " · (no GSTIN on file)"}
          {" · Expected series: "}
          <span className="font-mono">{expectedSeries}</span>
          {row.irn_required && <span className="ml-2 text-blue-900">· IRN required</span>}
        </div>
      </div>

      {/* Issuance context: everything accounts needs to re-create the invoice in Tally. */}
      <div className="rounded border bg-background p-3 text-xs space-y-2">
        <div className="font-medium text-foreground">Issuance details</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1.5">
          <div>
            <span className="text-muted-foreground">Statement: </span>
            <span className="font-mono">{row.statement_number ?? "—"}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Contract: </span>
            <span className="font-mono">{row.contract?.contract_number ?? "—"}</span>
            {row.contract?.title && <span className="text-muted-foreground"> · {row.contract.title}</span>}
          </div>
          {row.period_start && row.period_end && (
            <div className="md:col-span-2">
              <span className="text-muted-foreground">Period: </span>
              {row.period_start} → {row.period_end}
            </div>
          )}
          {row.tax.place_of_supply && (
            <div>
              <span className="text-muted-foreground">Place of supply: </span>
              {row.tax.place_of_supply}
              {row.tax.is_interstate && <span className="ml-1 text-amber-700">(interstate · IGST)</span>}
            </div>
          )}
          {row.tax.hsn_sac_code && (
            <div>
              <span className="text-muted-foreground">HSN/SAC: </span>
              <span className="font-mono">{row.tax.hsn_sac_code}</span>
            </div>
          )}
        </div>

        {/* Line items */}
        <div className="border-t pt-2">
          <div className="text-muted-foreground mb-1">Line items</div>
          <table className="w-full">
            <tbody>
              {row.line_items.fixed_amount > 0 && (
                <tr><td>Rent</td><td className="text-right tabular-nums">{formatCurrency(row.line_items.fixed_amount)}</td></tr>
              )}
              {row.line_items.service_usage_amount > 0 && (
                <tr><td>Service usage (print, electricity, etc.)</td><td className="text-right tabular-nums">{formatCurrency(row.line_items.service_usage_amount)}</td></tr>
              )}
              {row.line_items.booking_usage_amount > 0 && (
                <tr><td>Booking charges</td><td className="text-right tabular-nums">{formatCurrency(row.line_items.booking_usage_amount)}</td></tr>
              )}
              <tr className="border-t">
                <td className="pt-1 text-muted-foreground">Subtotal</td>
                <td className="pt-1 text-right tabular-nums">{formatCurrency(row.tax.subtotal)}</td>
              </tr>
              {row.tax.is_interstate ? (
                <tr>
                  <td className="text-muted-foreground">IGST @ {row.tax.tax_percentage}%</td>
                  <td className="text-right tabular-nums">{formatCurrency(row.tax.igst_amount ?? row.tax.tax_amount)}</td>
                </tr>
              ) : (
                <>
                  <tr>
                    <td className="text-muted-foreground">CGST @ {(row.tax.tax_percentage / 2).toFixed(1)}%</td>
                    <td className="text-right tabular-nums">{formatCurrency(row.tax.cgst_amount ?? row.tax.tax_amount / 2)}</td>
                  </tr>
                  <tr>
                    <td className="text-muted-foreground">SGST @ {(row.tax.tax_percentage / 2).toFixed(1)}%</td>
                    <td className="text-right tabular-nums">{formatCurrency(row.tax.sgst_amount ?? row.tax.tax_amount / 2)}</td>
                  </tr>
                </>
              )}
              <tr className="border-t font-medium">
                <td className="pt-1">Total</td>
                <td className="pt-1 text-right tabular-nums">{formatCurrency(row.statement_total_amount)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Payments received */}
        {row.payments_received.length > 0 && (
          <div className="border-t pt-2">
            <div className="text-muted-foreground mb-1">
              Payments received ({formatCurrency(row.total_paid)} of {formatCurrency(row.statement_total_amount)})
            </div>
            <table className="w-full">
              <tbody>
                {row.payments_received.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className="font-medium">{p.payment_mode}</span>
                      {p.payment_reference && <span className="text-muted-foreground"> · {p.payment_reference}</span>}
                      {p.razorpay_payment_id && <span className="text-muted-foreground"> · {p.razorpay_payment_id}</span>}
                      <span className="text-muted-foreground"> · {p.payment_date}</span>
                    </td>
                    <td className="text-right tabular-nums">{formatCurrency(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
            <>
              <Loader2 className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 animate-spin" aria-hidden />
              <span>Reading PDF…</span>
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" aria-hidden />
              <span>
                {autofillSource === "pdf_text" && `Autofilled ${autofilledFields.size} field${autofilledFields.size === 1 ? "" : "s"} from PDF text.`}
                {autofillSource === "bridge_match" && "Matched against Tally voucher list."}
                {autofillSource === "manual" && "Could not auto-extract. Please fill the fields manually."}
                {bridgeMatched && " ✓ Bridge-verified in Tally."}
                {" "}
                <span className="text-muted-foreground">Review each value carefully before saving.</span>
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
            autoComplete="off"
          />
        </label>

        <label className="text-xs">
          <span className="block mb-1 text-muted-foreground">
            IRN
            {customerHasGstin ? (
              <span className="text-red-600">* (64 chars)</span>
            ) : (
              <span className="ml-1">(not applicable for non-GST customer)</span>
            )}
          </span>
          <input
            type="text"
            value={irn}
            onChange={(e) => setIrn(e.target.value)}
            disabled={!customerHasGstin}
            placeholder={customerHasGstin ? "64-char hex IRN from NIC portal" : "—"}
            className="w-full rounded border px-2 py-1.5 text-sm font-mono disabled:bg-muted disabled:cursor-not-allowed"
            autoComplete="off"
          />
        </label>

        <label className="text-xs">
          <span className="block mb-1 text-muted-foreground">
            Invoice date<span className="text-red-600">*</span>
          </span>
          <input
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
            className="w-full rounded border px-2 py-1.5 text-sm"
          />
        </label>

        <label className="text-xs">
          <span className="block mb-1 text-muted-foreground">
            Invoice amount (₹)<span className="text-red-600">*</span> — must equal {formatCurrency(row.statement_total_amount)}
          </span>
          <input
            type="number"
            step="0.01"
            value={invoiceAmount}
            onChange={(e) => setInvoiceAmount(e.target.value)}
            className="w-full rounded border px-2 py-1.5 text-sm tabular-nums"
          />
        </label>
      </div>

      <label className="block text-xs">
        <span className="block mb-1 text-muted-foreground">
          Invoice PDF<span className="text-red-600">*</span>
        </span>
        <input
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setPdfFile(f);
            if (f && f.type === "application/pdf") {
              void runAutofill(f);
            }
          }}
          className="block w-full text-xs file:mr-3 file:px-3 file:py-1.5 file:border file:rounded file:bg-background file:text-sm hover:file:bg-muted"
        />
        {pdfFile && (
          <span className="text-xs text-muted-foreground mt-1 block">
            Selected: {pdfFile.name} ({Math.round(pdfFile.size / 1024)} KB)
          </span>
        )}
      </label>

      <label className="flex items-start gap-2 text-xs cursor-pointer p-2 rounded border bg-background">
        <input
          type="checkbox"
          checked={nameMatches}
          onChange={(e) => setNameMatches(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Party name on the invoice matches the contract party</span>
          <span className="block text-muted-foreground mt-0.5">
            Contract party: <span className="font-medium">{partyName}</span>.
            Check this only after verifying the PDF. If unchecked, the upload still
            saves but Save &amp; send stays blocked until an admin resolves the name check.
          </span>
        </span>
      </label>

      {validation.length > 0 && (
        <ul className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded p-2 space-y-0.5">
          {validation.map((v) => (
            <li key={v} className="flex items-start gap-1">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" aria-hidden />
              <span>{v}</span>
            </li>
          ))}
        </ul>
      )}

      {serverError && (
        <div className="text-xs text-red-900 bg-red-50 border border-red-200 rounded p-2 flex items-start gap-1">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" aria-hidden />
          <span>{serverError}</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-3 py-1.5 text-xs rounded border hover:bg-muted disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="px-3 py-1.5 text-xs rounded bg-foreground text-background hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
        >
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {submitting ? "Uploading…" : "Save upload"}
        </button>
      </div>
    </form>
  );
}
