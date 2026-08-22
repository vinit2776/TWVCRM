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
import { Upload, Loader2, AlertCircle, Sparkles, Eye } from "lucide-react";
import { formatCurrency, preventEnterSubmit } from "@/lib/utils";
import { isRealCompanyName, leadAddress, voBillParty, type InboxRow, type ExtractResponse, type AutofillSource } from "@/lib/tally-handoff";
import { ReimbursementSupportingDocuments } from "@/components/procurement/reimbursement-supporting-documents";

interface Props {
  row: InboxRow;
  onUploaded: () => void;
  onCancel: () => void;
}

// billing_statements.statement_type has more values than the narrow
// InboxLineItemBreakdown type declares (see types/index.ts) — switch on the
// raw string so real values like "electricity"/"reimbursement" still get a
// readable label instead of falling through to "Rent" or nothing at all.
function usageLineLabel(statementType: string | null): string {
  switch (statementType) {
    case "electricity": return "Electricity charges";
    case "reimbursement": return "Reimbursement charges";
    case "usage": return "Usage charges";
    default: return "Usage charges";
  }
}

export function TallyInboxUploadForm({ row, onUploaded, onCancel }: Props) {
  const lead = row.contract?.lead ?? row.proposal?.lead ?? row.invoice?.lead;
  // Virtual Office statements have no lead — the buyer is the case's bill_to
  // party (the aggregator, for partner-billed cases) or the statement's own
  // aggregator. Reading only the lead left accounts typing "(unnamed)" into
  // Tally against a B-series number while the row itself said IRN required.
  const voParty = voBillParty(row);
  const customerGstin = lead?.gst_number || voParty?.gstin || null;
  const customerHasGstin = !!customerGstin;
  const customerAddress = leadAddress(lead ?? null) || voParty?.address || null;
  const expectedSeries = customerHasGstin ? "SDIPL-REG" : "SDIPL-UNREG";
  const expectedPrefix = customerHasGstin ? "SD/A/" : "SD/B/";
  const partyName =
    (lead && isRealCompanyName(lead.company) ? lead.company : null)
    || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ")
    || voParty?.name || "(unnamed)";

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [irn, setIrn] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  const [invoiceAmount, setInvoiceAmount] = useState(String(row.statement_total_amount));
  const [partyNameOnInvoice, setPartyNameOnInvoice] = useState("");
  const [nameOverride, setNameOverride] = useState(false);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
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
      if (data.fields.party_name) {
        setPartyNameOnInvoice(data.fields.party_name);
        filled.add("party_name");
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
  const nameMismatch = useMemo(() => {
    const invoiceName = partyNameOnInvoice.trim().toLowerCase();
    const crmName = partyName.trim().toLowerCase();
    return invoiceName.length > 0 && invoiceName !== crmName;
  }, [partyNameOnInvoice, partyName]);

  const validation = useMemo(() => {
    const errors: string[] = [];
    if (!invoiceNumber.trim()) errors.push("Tally invoice number is required.");
    if (invoiceNumber && !invoiceNumber.startsWith(expectedPrefix)) {
      errors.push(`Invoice number must start with "${expectedPrefix}" for this customer.`);
    }
    if (customerHasGstin && irn.trim().length > 0 && irn.trim().length !== 64) {
      errors.push("IRN must be exactly 64 characters if provided.");
    }
    if (!customerHasGstin && irn.trim().length > 0) {
      errors.push("B-series (non-GST customer) must NOT have an IRN.");
    }
    if (!invoiceDate) errors.push("Invoice date is required.");
    const amount = Number(invoiceAmount);
    if (!Number.isFinite(amount) || amount <= 0) errors.push("Invoice amount must be positive.");
    if (Math.round(amount) !== Math.round(Number(row.statement_total_amount))) {
      errors.push(
        `Amount ₹${amount} does not match statement total ₹${row.statement_total_amount}. Fix Tally or void+reissue — no override.`,
      );
    }
    if (!pdfFile) errors.push("Invoice PDF is required.");
    if (nameMismatch && !nameOverride) errors.push("Party name mismatch — tick 'Proceed anyway' below to override.");
    return errors;
  }, [invoiceNumber, irn, invoiceDate, invoiceAmount, pdfFile, customerHasGstin, expectedPrefix, row.statement_total_amount, nameMismatch, nameOverride]);

  const canSubmit = validation.length === 0 && !submitting;

  async function handlePreview() {
    if (!pdfFile) return;
    setPreviewing(true);
    try {
      const fd = new FormData();
      fd.append("file", pdfFile);
      const res = await fetch(
        `/api/billing-statements/${row.statement_id}/preview-gst-stamp`,
        { method: "POST", body: fd },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setServerError(body.error || `Preview failed (HTTP ${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      // Revoke after a short delay to allow the tab to load the blob.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setServerError("Preview failed — check your connection and try again.");
    } finally {
      setPreviewing(false);
    }
  }

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
          party_name_matches_contract: !nameMismatch || nameOverride,
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

      const body = await res.json().catch(() => ({}));
      if (body.email_warning) {
        setEmailWarning(body.email_warning);
        setSubmitting(false);
        return;
      }

      onUploaded();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Upload failed");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="border-t bg-muted/30 p-4 space-y-3">
      <div className="text-sm">
        <div className="font-medium">Upload Tally GST invoice</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          Customer: <span className="font-medium">{partyName}</span>
          {customerGstin ? ` · GSTIN ${customerGstin}` : " · (no GSTIN on file)"}
          {" · Expected series: "}
          <span className="font-mono">{expectedSeries}</span>
          {row.irn_required && <span className="ml-2 text-blue-900">· IRN required</span>}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {customerAddress ? (
            <>Address: {customerAddress}</>
          ) : (
            <span className="text-amber-700">No address on file — check with the customer before raising the invoice.</span>
          )}
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
          {row.invoice && (
            // Ad-hoc invoices have no contract, so the line-item description
            // is often shorthand a person typed (e.g. "SD - Additional Seat").
            // The invoice's own title is usually clearer — surface it here
            // instead of silently discarding it.
            <div className="md:col-span-2 bg-secondary rounded px-2 py-1 -mx-1">
              <span className="text-muted-foreground">Invoice: </span>
              <span className="font-mono">{row.invoice.invoice_number}</span>
              {row.invoice.title && <span className="text-muted-foreground"> · {row.invoice.title}</span>}
            </div>
          )}
          {row.invoice?.internal_notes && (
            <div className="md:col-span-2 rounded border border-amber-200 bg-amber-50 text-amber-900 px-2.5 py-2 text-sm leading-snug">
              <div className="text-[0.65rem] font-semibold uppercase tracking-wide opacity-80 mb-0.5">
                Internal note (accounts only)
              </div>
              {row.invoice.internal_notes}
            </div>
          )}
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
          <div className="flex items-baseline justify-between gap-2 mb-1">
            <div className="text-muted-foreground">Line items</div>
            {/* Reimbursement statements must have a receipt/vendor bill attached
                (enforced at Bill Customer time) — surfaced here so accounts can
                cross-check it against the Tally amount before uploading. It's
                merged into the invoice PDF automatically at upload; nothing to
                do here beyond looking. */}
            {(row.line_items.statement_type as string) === "reimbursement" && row.supporting_documents_count > 0 && (
              <ReimbursementSupportingDocuments
                statementId={row.statement_id}
                count={row.supporting_documents_count}
                triggerClassName="flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
              />
            )}
            {/* When the buyer is the aggregator, nothing else on this row says
                which referred client the fee is for. Statements created before
                the description carried it have only this. */}
            {row.case && row.case.bill_to === "aggregator" && (
              <div className="text-muted-foreground truncate">
                For:{" "}
                <span className="text-foreground font-medium">
                  {row.case.client_company_name || row.case.client_name}
                </span>
                <span className="font-mono"> · {row.case.case_number}</span>
              </div>
            )}
          </div>
          <table className="w-full">
            <tbody>
              {row.itemized_charges.length > 0 ? (
                // Real per-charge detail — same source proforma-pdf builds from
                // (structured line_items, falling back to usage_charges rows).
                row.itemized_charges.map((c, i) => (
                  <tr key={i}>
                    <td className="py-0.5 align-top">
                      <div>
                        {c.description}
                        {c.quantity !== 1 && (
                          <span className="text-muted-foreground"> · {c.quantity} × {formatCurrency(c.unit_price)}</span>
                        )}
                      </div>
                      {c.notes && <div className="text-muted-foreground italic">{c.notes}</div>}
                    </td>
                    <td className="py-0.5 text-right tabular-nums align-top">{formatCurrency(c.amount)}</td>
                  </tr>
                ))
              ) : (
                <>
                  {row.line_items.fixed_amount > 0 && (
                    <tr><td>Rent</td><td className="text-right tabular-nums">{formatCurrency(row.line_items.fixed_amount)}</td></tr>
                  )}
                  {row.line_items.service_usage_amount > 0 && (
                    <tr><td>Service usage (print, electricity, etc.)</td><td className="text-right tabular-nums">{formatCurrency(row.line_items.service_usage_amount)}</td></tr>
                  )}
                  {row.line_items.booking_usage_amount > 0 && (
                    <tr><td>Booking charges</td><td className="text-right tabular-nums">{formatCurrency(row.line_items.booking_usage_amount)}</td></tr>
                  )}
                  {/* Some statement types only ever populate the coarse usage_amount
                      total with no per-charge detail anywhere — without this fallback
                      the table renders with zero rows and accounts has no idea what
                      they're actually billing. */}
                  {row.line_items.service_usage_amount === 0
                    && row.line_items.booking_usage_amount === 0
                    && row.line_items.usage_amount > 0 && (
                    <tr>
                      <td>{usageLineLabel(row.line_items.statement_type)}</td>
                      <td className="text-right tabular-nums">{formatCurrency(row.line_items.usage_amount)}</td>
                    </tr>
                  )}
                </>
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
              <span className="ml-1">(optional · 64 chars · autofilled when detected)</span>
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

      {/* Party name check — compare Tally invoice name against CRM record */}
      <label className="block text-xs">
        <span className="block mb-1 text-muted-foreground">
          Party name on Tally invoice
          <span className="ml-1 text-muted-foreground/70">(cross-check with CRM: <strong className="text-foreground">{partyName}</strong>)</span>
        </span>
        <input
          type="text"
          value={partyNameOnInvoice}
          onChange={(e) => { setPartyNameOnInvoice(e.target.value); setNameOverride(false); }}
          placeholder={partyName}
          className={`w-full rounded border px-2 py-1.5 text-sm ${nameMismatch ? "border-amber-400 bg-amber-50" : ""}`}
          autoComplete="off"
        />
      </label>
      {nameMismatch && (
        <div className="rounded border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 space-y-2">
          <div className="flex items-start gap-1.5 font-medium">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" aria-hidden />
            Name mismatch — invoice says &ldquo;{partyNameOnInvoice}&rdquo; but CRM has &ldquo;{partyName}&rdquo;.
          </div>
          <p className="text-amber-800">
            Fix the name in Tally before uploading, or tick below if this is intentional (e.g. trading name vs registered name).
          </p>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={nameOverride}
              onChange={(e) => setNameOverride(e.target.checked)}
              className="rounded"
            />
            <span>Proceed anyway — I confirm the names refer to the same entity</span>
          </label>
        </div>
      )}

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
          <span className="mt-1 flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {pdfFile.name} ({Math.round(pdfFile.size / 1024)} KB)
            </span>
            {pdfFile.type === "application/pdf" && (
              <button
                type="button"
                onClick={() => void handlePreview()}
                disabled={previewing || submitting}
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border hover:bg-muted disabled:opacity-50"
              >
                {previewing
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <Eye className="h-3 w-3" />}
                {previewing ? "Generating…" : "Preview stamped"}
              </button>
            )}
          </span>
        )}
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

      {emailWarning && (
        <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded p-2 flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" aria-hidden />
          <span>
            <span className="font-semibold block">Invoice uploaded but email failed to send.</span>
            {emailWarning}
          </span>
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
          {submitting ? "Uploading & sending…" : "Upload & Send"}
        </button>
      </div>
    </form>
  );
}
