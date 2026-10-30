"use client";

import { memo, useMemo } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  checkInvoice,
  completeAmounts,
  type EnteredBill,
  type ExtractedInvoice,
  type SuggestionField,
} from "@/lib/procurement/invoice-check";
import { invoiceCheckFailureMessage, type InvoiceCheckReason } from "@/lib/procurement/invoice-check-reasons";

export type InvoiceCheckState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable"; reason: InvoiceCheckReason }
  | { status: "ok"; extracted: ExtractedInvoice };

interface Props {
  state: InvoiceCheckState;
  entered: EnteredBill;
  poCeiling: number | null;
  /** Called only when the user clicks a suggestion; the parent decides how to set the field. */
  onApply: (field: SuggestionField, value: string) => void;
}

const inr = (n: number | null) =>
  n === null ? "—" : `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const CONFIDENCE_COPY = {
  high: "Read clearly from the file",
  medium: "Read from the file — worth a glance",
  low: "Hard to read — double-check these figures",
} as const;

// Advisory only: shows what the uploaded invoice says next to what was typed.
// Never blocks submission and never changes a field by itself.
export const InvoiceCheckCard = memo(function InvoiceCheckCard({ state, entered, poCeiling, onApply }: Props) {
  const extracted = state.status === "ok" ? state.extracted : null;

  const findings = useMemo(
    () => (extracted ? checkInvoice({ extracted, entered, poCeiling }) : []),
    [extracted, entered, poCeiling],
  );

  if (state.status === "idle") return null;

  if (state.status === "unavailable") {
    return (
      <p className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" data-testid="invoice-check-unavailable">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        {invoiceCheckFailureMessage(state.reason)}
      </p>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading the invoice to double-check your entries…
      </div>
    );
  }

  const { subtotal, gst, total } = completeAmounts(state.extracted);
  const x = state.extracted;
  const flagged = (...codes: string[]) => findings.some((f) => codes.includes(f.code));

  const rows: { label: string; onInvoice: string; typed: string; warn: boolean }[] = [
    { label: "Invoice number", onInvoice: x.invoiceNumber ?? "—", typed: entered.invoiceNumber.trim() || "—", warn: flagged("invoice_number_mismatch") },
    { label: "Invoice date", onInvoice: x.invoiceDate ?? "—", typed: entered.invoiceDate || "—", warn: flagged("invoice_date_mismatch") },
    { label: "Vendor", onInvoice: x.vendorName ?? "—", typed: entered.vendorName ?? "—", warn: flagged("vendor_mismatch") },
    { label: "Amount before GST", onInvoice: inr(subtotal), typed: inr(entered.amount), warn: flagged("amount_looks_gst_inclusive", "amount_differs_subtotal", "amount_above_po") },
    { label: "GST", onInvoice: inr(gst), typed: inr(entered.gstAmount), warn: flagged("gst_differs") },
    { label: "Invoice total", onInvoice: inr(total), typed: "", warn: false },
  ];

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-3" data-testid="invoice-check-card">
      <div className="flex items-start gap-2">
        <ScanSearch className="h-4 w-4 mt-0.5 text-primary shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-medium">Check against the uploaded invoice</p>
          <p className="text-xs text-muted-foreground">
            {CONFIDENCE_COPY[x.confidence]}. This is a guide only — nothing is changed unless you click a suggestion.
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="font-normal pb-1 pr-3">&nbsp;</th>
              <th className="font-normal pb-1 pr-3">On the invoice</th>
              <th className="font-normal pb-1">You entered</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.warn ? "bg-amber-50 text-amber-900" : ""}>
                <td className="py-1 pr-3 text-muted-foreground">{r.label}</td>
                <td className="py-1 pr-3 font-medium">{r.onInvoice}</td>
                <td className="py-1 font-medium">{r.typed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {findings.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-green-700">
          <CheckCircle2 className="h-3.5 w-3.5" />
          What you entered matches the invoice.
        </p>
      ) : (
        <ul className="space-y-2">
          {findings.map((f) => (
            <li key={f.code} className="flex flex-wrap items-center gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 min-w-[12rem]">{f.message}</span>
              {f.suggestion && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 bg-white px-2 text-xs"
                  onClick={() => onApply(f.suggestion!.field, f.suggestion!.value)}
                >
                  {f.suggestion.label}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});
