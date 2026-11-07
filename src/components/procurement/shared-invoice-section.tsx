"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/utils";

/** What /api/procurement/bills/same-invoice returns when bills already carry the typed invoice number. */
export interface SameInvoiceLookup {
  existing: Array<{
    id: string;
    bill_number: string;
    po_number: string | null;
    invoice_date: string;
    total_amount: number;
    approval_status: string;
    payment_status: string;
    amount_paid: number;
  }>;
  invoice_total: number;
  allocated: number;
  left: number;
  can_join: boolean;
  reason: string | null;
}

export type ShareChoice = "none" | "open" | "join";

function statusLine(b: SameInvoiceLookup["existing"][number]): string {
  const paid = b.payment_status === "paid" ? "approved and paid" : b.approval_status === "approved" ? "approved" : b.approval_status === "pending" ? "awaiting approval" : b.approval_status;
  return `${b.bill_number}${b.po_number ? ` (${b.po_number})` : ""}: ${paid}, ${formatCurrency(b.total_amount)}`;
}

interface Props {
  choice: ShareChoice;
  /** The amount field's value: this PO's share once the invoice is shared. */
  share: number;
  invoiceTotal: string;
  onInvoiceTotalChange: (v: string) => void;
  /** The amount typed is above this PO and the form is not yet in shared mode. */
  exceedsPo: boolean;
  poNumber: string | null;
  poValue: number | null;
  lookup: SameInvoiceLookup | null;
  onOpen: () => void;
  onJoin: () => void;
  onBackToNormal: () => void;
  onUseDifferentNumber: () => void;
}

/**
 * The prompts and fields for one vendor invoice that covers several POs. It appears on its own:
 * when the amount typed is more than the PO, or when the invoice number is already on another bill.
 */
export function SharedInvoiceSection(props: Props) {
  const { choice, share, invoiceTotal, lookup } = props;
  const total = parseFloat(invoiceTotal);
  const totalOk = Number.isFinite(total) && total > 0;

  // The invoice number is already on other bills.
  if (lookup && lookup.existing.length > 0 && choice !== "join") {
    return (
      <div className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-900 space-y-2" role="alert">
        <p className="font-semibold">
          {lookup.can_join ? "This invoice number is already on another PO" : "This invoice number is already recorded"}
        </p>
        <div className="rounded bg-white px-3 py-2 text-xs text-foreground space-y-0.5">
          {lookup.existing.map((b) => <p key={b.id}>{statusLine(b)}</p>)}
          {lookup.can_join && (
            <p className="pt-1 text-muted-foreground">{formatCurrency(lookup.left)} of the {formatCurrency(lookup.invoice_total)} invoice is left to allocate.</p>
          )}
        </div>
        {lookup.can_join ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={props.onJoin}>Yes, same invoice — add {props.poNumber ?? "this PO"}</Button>
            <Button type="button" size="sm" variant="outline" onClick={props.onUseDifferentNumber}>Use a different invoice number</Button>
          </div>
        ) : (
          <p className="text-xs text-red-700">{lookup.reason}</p>
        )}
      </div>
    );
  }

  // The amount typed is more than this PO: maybe the invoice covers other POs too.
  if (props.exceedsPo && choice === "none") {
    return (
      <div className="rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-900 space-y-2" role="alert">
        <p className="font-semibold">
          This is more than {props.poNumber ?? "the PO"}{props.poValue ? ` (${formatCurrency(props.poValue)})` : ""}
        </p>
        <p className="text-xs">Does this invoice also cover other POs?</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={props.onOpen}>Yes, it covers other POs</Button>
          <span className="self-center text-xs text-muted-foreground">If not, correct the amount.</span>
        </div>
      </div>
    );
  }

  if (choice === "none") return null;

  const allocatedElsewhere = choice === "join" && lookup ? lookup.allocated : 0;
  const left = totalOk ? Math.max(0, total - allocatedElsewhere - (share > 0 ? share : 0)) : null;
  const over = totalOk && share > 0 && allocatedElsewhere + share > total + 0.01;
  const raised = choice === "join" && lookup && totalOk && total > lookup.invoice_total + 0.01;

  return (
    <div className="rounded-lg border bg-muted/20 px-4 py-3 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold">
          {choice === "join" ? "Adding this PO to the shared invoice" : "This invoice covers more than this PO"}
        </p>
        {choice === "open" && (
          <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={props.onBackToNormal}>
            It only covers this PO
          </Button>
        )}
      </div>

      {choice === "join" && lookup && (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded border bg-white px-2 py-1.5"><p className="text-muted-foreground">Invoice total</p><p className="font-semibold">{formatCurrency(totalOk ? total : lookup.invoice_total)}</p></div>
          <div className="rounded border bg-white px-2 py-1.5"><p className="text-muted-foreground">Already allocated</p><p className="font-semibold">{formatCurrency(lookup.allocated)}</p></div>
          <div className="rounded border border-teal-700/40 bg-teal-50 px-2 py-1.5"><p className="text-muted-foreground">Left to allocate</p><p className="font-semibold text-teal-800">{formatCurrency(totalOk ? Math.max(0, total - lookup.allocated) : lookup.left)}</p></div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="shared_invoice_total">
          Total on the vendor&apos;s invoice (₹) <span className="text-red-500">*</span>
          {choice === "join" && lookup && (
            <span className="ml-2 font-normal text-muted-foreground">(was {formatCurrency(lookup.invoice_total)})</span>
          )}
        </Label>
        <Input
          id="shared_invoice_total"
          type="number"
          min="0.01"
          step="0.01"
          value={invoiceTotal}
          onChange={(e) => props.onInvoiceTotalChange(e.target.value)}
        />
        {raised && lookup && (
          <p className="text-xs text-muted-foreground">
            Updates the total from {formatCurrency(lookup.invoice_total)} to {formatCurrency(total)}. The earlier bills&apos; own shares stay as they are.
          </p>
        )}
      </div>

      {over ? (
        <p className="text-xs text-red-600 flex items-start gap-1">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          {formatCurrency(allocatedElsewhere + share - total)} more than is left on the invoice. Reduce this PO&apos;s share, or raise the invoice total if it is higher.
        </p>
      ) : left !== null && share > 0 ? (
        left > 0.01 ? (
          <p className="text-xs text-amber-800 flex items-start gap-1">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            {formatCurrency(left)} of this invoice would still not be on any PO. Accounts sees it flagged until the other PO is added.
          </p>
        ) : (
          <p className="text-xs text-green-700 flex items-start gap-1">
            <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            The invoice would be fully allocated.
          </p>
        )
      ) : null}
      <p className="text-xs text-muted-foreground">Enter this PO&apos;s share of the invoice in the amount field below.</p>
    </div>
  );
}
