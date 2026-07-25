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
import { Loader2, ShieldAlert, Info, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { ACCOUNTING_HEADS, ACCOUNTING_HEAD_LABELS, type AccountingHead } from "@/lib/constants";

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
  const [primaryHead, setPrimaryHead] = useState<AccountingHead | "">("");
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<LineItemData[]>([
    { description: "", quantity: 1, unit_price: 0, total: 0 },
  ]);
  const [taxPercentage, setTaxPercentage] = useState(18);
  const [discountPercentage, setDiscountPercentage] = useState(0);
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isDeposit = primaryHead === "security_deposit";

  const resetForm = () => {
    setPrimaryHead("");
    setTitle("");
    setItems([{ description: "", quantity: 1, unit_price: 0, total: 0 }]);
    setTaxPercentage(18);
    setDiscountPercentage(0);
    setDueDate("");
    setNotes("");
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

    setSubmitting(true);

    const body = {
      lead_id: leadId,
      proposal_id: proposalId || undefined,
      primary_head: primaryHead,
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
              onValueChange={(v) => setPrimaryHead(v as AccountingHead)}
            >
              <SelectTrigger id="invoice-purpose">
                <SelectValue placeholder="Select a purpose" />
              </SelectTrigger>
              <SelectContent>
                {ACCOUNTING_HEADS.map((head) => (
                  <SelectItem key={head} value={head}>
                    {ACCOUNTING_HEAD_LABELS[head]}
                  </SelectItem>
                ))}
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
                <Label htmlFor="invoice-notes">Notes</Label>
                <Textarea
                  id="invoice-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Internal notes..."
                  rows={2}
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
