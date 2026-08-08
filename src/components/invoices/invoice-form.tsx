"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LineItemsEditor, type LineItemData } from "@/components/shared/line-items-editor";
import { Loader2, ShieldAlert, Info, ArrowRight, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { ACCOUNTING_HEADS, ACCOUNTING_HEAD_LABELS, type AccountingHead } from "@/lib/constants";
import { CheckAccountingNoteButton } from "@/components/accounting/check-accounting-note-button";

// "Other Income" is too open-ended a catch-all for staff to reach for by
// default — new invoices pick from the remaining heads, or "I don't know".
const SELECTABLE_HEADS = ACCOUNTING_HEADS.filter((h) => h !== "other_income");

interface InvoiceFormProps {
  leadId: string;
  proposalId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  // Whether this lead has a non-terminal proposal to route to when the user
  // picks "Security Deposit" — deposits are always collected there, never
  // via an ad-hoc invoice.
  hasActiveProposal: boolean;
  activeProposalId?: string;
  onRequestProposal: () => void;
}

export function InvoiceForm({
  leadId,
  proposalId,
  open,
  onOpenChange,
  onSuccess,
  hasActiveProposal,
  activeProposalId,
  onRequestProposal,
}: InvoiceFormProps) {
  const router = useRouter();
  const [primaryHead, setPrimaryHead] = useState<AccountingHead | "unsure" | "">("");
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<LineItemData[]>([
    { description: "", quantity: 1, unit_price: 0, total: 0 },
  ]);
  const [taxPercentage, setTaxPercentage] = useState(18);
  const [discountPercentage, setDiscountPercentage] = useState(0);
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Set when the mandatory pre-submit note check comes back with ok: false.
  // Cleared on the next submit attempt or once the user edits the note.
  const [noteWarning, setNoteWarning] = useState<string | null>(null);

  const isDeposit = primaryHead === "security_deposit";

  const resetForm = () => {
    setPrimaryHead("");
    setTitle("");
    setItems([{ description: "", quantity: 1, unit_price: 0, total: 0 }]);
    setTaxPercentage(18);
    setDiscountPercentage(0);
    setDueDate("");
    setNotes("");
    setInternalNotes("");
    setNoteWarning(null);
  };

  const handleGoToProposal = () => {
    onOpenChange(false);
    resetForm();
    if (hasActiveProposal && activeProposalId) {
      router.push(`/proposals/${activeProposalId}`);
    } else {
      onRequestProposal();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!primaryHead) {
      toast.error("Select what this invoice is for");
      return;
    }

    if (!title.trim()) {
      toast.error("Please enter an invoice title");
      return;
    }

    const validItems = items.filter((item) => item.description.trim());
    if (validItems.length === 0) {
      toast.error("Please add at least one line item with a description");
      return;
    }

    const invalidQty = validItems.find((item) => item.quantity <= 0);
    if (invalidQty) {
      toast.error("Each line item must have a quantity of at least 1");
      return;
    }

    if (internalNotes.trim().length < 10) {
      toast.error("Add an internal note (at least 10 characters) so accounts can book this correctly");
      return;
    }

    setSubmitting(true);
    setNoteWarning(null);

    // Mandatory gate: the internal note must give accounts real context before
    // an invoice can be created — not just satisfy the length check above.
    // If the check service itself is unavailable (unconfigured key, model error,
    // network failure), fail OPEN so a third-party outage can't block invoicing —
    // only an explicit ok:false from the model blocks submission.
    try {
      const checkRes = await fetch("/api/accounting/validate-internal-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: internalNotes.trim(),
          accounting_head: primaryHead !== "unsure" ? ACCOUNTING_HEAD_LABELS[primaryHead] : undefined,
          context: title.trim() || "ad-hoc invoice",
        }),
      });
      if (checkRes.ok) {
        const checkJson = await checkRes.json().catch(() => null);
        if (checkJson && typeof checkJson.ok === "boolean" && !checkJson.ok) {
          setNoteWarning(checkJson.reason || "This note doesn't give accounts enough context — add specifics.");
          toast.error("Add more context to the internal note before creating this invoice");
          setSubmitting(false);
          return;
        }
      }
    } catch {
      // Network failure — fail open, same as above.
    }

    const body = {
      lead_id: leadId,
      proposal_id: proposalId || undefined,
      primary_head: primaryHead === "unsure" ? null : primaryHead,
      title: title.trim(),
      items: validItems.map((item) => ({
        description: item.description,
        quantity: Math.max(1, item.quantity),
        unit: item.unit || undefined,
        unit_price: item.unit_price,
        total: Math.max(1, item.quantity) * item.unit_price,
      })),
      tax_percentage: taxPercentage,
      discount_percentage: discountPercentage,
      due_date: dueDate || undefined,
      notes: notes.trim() || undefined,
      internal_notes: internalNotes.trim(),
    };

    const res = await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setSubmitting(false);
    if (res.ok) {
      toast.success("Invoice created successfully");
      resetForm();
      onOpenChange(false);
      onSuccess();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to create invoice");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Ad-Hoc Proforma Invoice</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="invoice-purpose">
              What is this invoice for? <span className="text-destructive">*</span>
            </Label>
            <Select
              value={primaryHead}
              onValueChange={(v) => setPrimaryHead(v as AccountingHead | "unsure")}
            >
              <SelectTrigger id="invoice-purpose">
                <SelectValue placeholder="Select a purpose" />
              </SelectTrigger>
              <SelectContent>
                {SELECTABLE_HEADS.map((head) => (
                  <SelectItem key={head} value={head}>
                    {ACCOUNTING_HEAD_LABELS[head]}
                  </SelectItem>
                ))}
                <SelectItem value="unsure">I don&apos;t know</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isDeposit ? (
            <Card className="border-amber-300 bg-amber-50">
              <CardHeader className="pb-3">
                <CardTitle className="text-base text-amber-800 flex items-center gap-2">
                  <ShieldAlert className="h-5 w-5" />
                  Security deposits aren&apos;t collected this way
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-md border border-amber-200 bg-white px-4 py-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <Info className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                    <div className="text-xs text-amber-800 space-y-1">
                      <p>
                        Security deposits are refundable and GST-exempt — collecting one through an
                        ad-hoc invoice books it as taxed revenue and it won&apos;t be tracked against
                        the customer&apos;s deposit balance or be adjustable later.
                      </p>
                      <p className="font-medium">
                        {hasActiveProposal
                          ? "Use the deposit link on this lead's proposal instead."
                          : "Deposits are collected on proposals — create one first."}
                      </p>
                    </div>
                  </div>
                </div>
                <Button
                  type="button"
                  className="w-full bg-amber-600 hover:bg-amber-700 text-white"
                  onClick={handleGoToProposal}
                >
                  {hasActiveProposal ? "Go to Proposal" : "Create Proposal First"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="invoice-title">
                  Title <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="invoice-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Private Office - January 2026"
                />
              </div>

              {/* Line Items */}
              <div>
                <Label className="mb-3 block">Line Items</Label>
                <LineItemsEditor
                  items={items}
                  onChange={setItems}
                  taxPercentage={taxPercentage}
                  onTaxChange={setTaxPercentage}
                  discountPercentage={discountPercentage}
                  onDiscountChange={setDiscountPercentage}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="due-date">Due Date</Label>
                <Input
                  id="due-date"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="invoice-notes">Customer-Facing Notes</Label>
                <Textarea
                  id="invoice-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Appears on the invoice PDF and email sent to the customer..."
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="invoice-internal-notes">
                  Internal Note (for Accounts) <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="invoice-internal-notes"
                  value={internalNotes}
                  onChange={(e) => {
                    setInternalNotes(e.target.value);
                    if (noteWarning) setNoteWarning(null);
                  }}
                  placeholder={
                    primaryHead === "unsure"
                      ? "Describe what this is for so accounts can figure out the right head — never shown to the customer"
                      : "Why this invoice exists and how accounts should book it — never shown to the customer"
                  }
                  rows={2}
                />
                {noteWarning && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 flex items-start gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{noteWarning}</span>
                  </div>
                )}
                <CheckAccountingNoteButton
                  note={internalNotes}
                  accountingHead={primaryHead && primaryHead !== "unsure" ? ACCOUNTING_HEAD_LABELS[primaryHead] : undefined}
                  context={title || "ad-hoc invoice"}
                />
              </div>
            </>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            {!isDeposit && (
              <Button type="submit" disabled={submitting || !primaryHead}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Invoice
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
