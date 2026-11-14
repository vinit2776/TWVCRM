"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import { classifyAmountChange } from "@/lib/procurement/bill-edit-rules";
import { InvoiceCheckCard, type InvoiceCheckState } from "@/components/procurement/invoice-check-card";
import { requestInvoiceExtraction } from "@/lib/procurement/invoice-extract-client";
import type { SuggestionField } from "@/lib/procurement/invoice-check";
import type { VendorBill } from "@/types";

interface Props {
  bill: VendorBill;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void | Promise<void>;
  /** PO value (or cycle cost) the pre-GST amount must stay within. */
  poValue?: number | null;
  /** The open question this correction answers, pinned on top. */
  pinnedAsk?: { by: string | null; message: string | null } | null;
}

/** Corrects a vendor bill's invoice details before any payment is recorded. */
export function BillEditDialog({ bill, open, onOpenChange, onSaved, poValue = null, pinnedAsk = null }: Props) {
  const approved = bill.approval_status === "approved";
  const fileRef = useRef<HTMLInputElement>(null);
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  // Advisory read of a replacement invoice file (never blocks, never overwrites typed values)
  const [invoiceCheck, setInvoiceCheck] = useState<InvoiceCheckState>({ status: "idle" });
  const extractSeq = useRef(0);

  useEffect(() => {
    if (!open) return;
    setInvoiceNumber(bill.invoice_number ?? "");
    setInvoiceDate(bill.invoice_date ?? "");
    setDueDate(bill.due_date ?? "");
    setAmount(bill.total_amount != null ? String(bill.total_amount) : "");
    setNotes(bill.notes ?? "");
    setReason("");
    setFile(null);
    extractSeq.current++;
    setInvoiceCheck({ status: "idle" });
  }, [open, bill]);

  const onPickFile = (f: File | null) => {
    setFile(f);
    const seq = ++extractSeq.current;
    if (!f) { setInvoiceCheck({ status: "idle" }); return; }
    setInvoiceCheck({ status: "loading" });
    requestInvoiceExtraction(f).then((result) => {
      if (seq === extractSeq.current) setInvoiceCheck(result.ok ? { status: "ok", extracted: result.extracted } : { status: "unavailable", reason: result.reason });
    });
  };

  const applySuggestion = useCallback((field: SuggestionField, value: string) => {
    if (field === "amount") setAmount(value);
    else if (field === "invoiceNumber") setInvoiceNumber(value);
    else if (field === "invoiceDate") setInvoiceDate(value);
  }, []);

  const parsedAmount = parseFloat(amount);
  const change = Number.isFinite(parsedAmount) ? classifyAmountChange(Number(bill.total_amount ?? 0), parsedAmount) : "unchanged";

  const enteredForCheck = useMemo(
    () => ({ invoiceNumber, invoiceDate, vendorName: null, amount: Number.isFinite(parsedAmount) && parsedAmount > 0 ? parsedAmount : null, gstAmount: null }),
    [invoiceNumber, invoiceDate, parsedAmount],
  );

  const overBy = poValue !== null && Number.isFinite(parsedAmount) ? parsedAmount - poValue : 0;
  const amountProblem = overBy > 0.01;

  async function save() {
    if (!invoiceDate) { toast.error("Invoice date is required"); return; }
    if (!amount || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error("Amount must be greater than 0");
      return;
    }
    if (approved && reason.trim().length < 5) {
      toast.error("Add a short reason for the correction");
      return;
    }
    setSaving(true);
    try {
      let fileUrl = bill.invoice_file_url ?? null;
      if (file) {
        const supabase = createBrowserClient();
        const ext = file.name.split(".").pop() ?? "pdf";
        const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { error: upErr } = await supabase.storage.from("vendor-invoices").upload(path, file);
        if (upErr) { toast.error(`File upload failed: ${upErr.message}`); return; }
        fileUrl = supabase.storage.from("vendor-invoices").getPublicUrl(path).data.publicUrl;
      }
      const res = await fetch(`/api/procurement/bills/${bill.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "edit_invoice_details",
          invoice_number: invoiceNumber.trim() || null,
          invoice_date: invoiceDate,
          due_date: dueDate || null,
          total_amount: parsedAmount,
          notes: notes.trim() || null,
          invoice_file_url: fileUrl,
          reason: reason.trim() || null,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Failed to save correction");
        return;
      }
      toast.success(approved && change === "raised" ? "Corrected — sent back for approval" : "Invoice corrected");
      onOpenChange(false);
      await onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Correct amount / Edit invoice — {bill.bill_number}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {pinnedAsk?.message && (
            <div className="rounded-md border-2 border-red-300 bg-red-50 px-3 py-2">
              <p className="text-sm font-medium text-red-800">
                Open query{pinnedAsk.by ? ` from ${pinnedAsk.by}` : ""} — latest: &ldquo;{pinnedAsk.message}&rdquo;
              </p>
              {poValue !== null && <p className="text-xs text-red-800">Enter the pre-GST amount. Max allowed: {formatCurrency(poValue)}.</p>}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            You can correct this bill until a payment is recorded. Enter the <strong>pre-GST amount</strong> — it can&apos;t be more than the PO.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="edit-inv-number">Invoice Number</Label>
              <Input id="edit-inv-number" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} placeholder="Vendor's invoice #" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-inv-amount" className={amountProblem ? "text-red-700" : ""}>Amount, pre-GST (₹) <span className="text-red-500">*</span>{amountProblem && " — fix this"}</Label>
              <Input id="edit-inv-amount" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={amountProblem ? "border-2 border-red-400" : ""} />
              <p className={`text-[11px] ${amountProblem ? "text-red-700" : "text-muted-foreground"}`}>
                {amountProblem ? `${formatCurrency(overBy)} over the PO` : `Now: ${formatCurrency(Number(bill.total_amount ?? 0))}`}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-inv-date">Invoice Date <span className="text-red-500">*</span></Label>
              <Input id="edit-inv-date" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-inv-due">Due Date</Label>
              <Input id="edit-inv-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Invoice File</Label>
            {bill.invoice_file_url && (
              <a href={bill.invoice_file_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                <Paperclip className="h-3 w-3" /> View current file
              </a>
            )}
            <Input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} />
            <p className="text-[11px] text-muted-foreground">Leave empty to keep the current file. To add extra paperwork instead, use Supporting Documents.</p>
            <InvoiceCheckCard state={invoiceCheck} entered={enteredForCheck} poCeiling={poValue} onApply={applySuggestion} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-inv-notes">Notes</Label>
            <Textarea id="edit-inv-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {approved && (
            <div className="space-y-1.5">
              <Label htmlFor="edit-inv-reason">Reason for the correction <span className="text-red-500">*</span></Label>
              <Textarea id="edit-inv-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Entered GST-inclusive by mistake" />
              <p className="text-[11px] text-muted-foreground">Accounts is notified, and it is posted on any open query for this bill.</p>
            </div>
          )}
          {approved && change === "raised" && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              The amount is going up, so this bill goes back to the admin for approval.
            </div>
          )}
          {change !== "unchanged" && (
            <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              The amount is changing, so any GST already entered will be cleared and Accounts re-enters it from the invoice.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Save correction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
