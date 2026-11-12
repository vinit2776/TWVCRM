"use client";

import { useEffect, useState } from "react";
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
import { preventEnterSubmit } from "@/lib/utils";
import { isContractOperational } from "@/lib/constants";
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
  // Set when a guided flow (the contract page's Invoice wizard) has already
  // asked what the invoice is for — the purpose is then shown, not chosen.
  presetHead?: AccountingHead;
  // Set when the caller already knows which contract this invoice belongs to
  // (the contract page's Invoice wizard) — the customer's live contracts are
  // then not looked up or asked about.
  contractId?: string;
  // Receives the created invoice so a caller can follow up (e.g. attach it to a contract).
  onCreated?: (invoice: { id: string }) => void | Promise<void>;
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
  presetHead,
  contractId,
  onCreated,
}: InvoiceFormProps) {
  const router = useRouter();
  const [primaryHead, setPrimaryHead] = useState<AccountingHead | "unsure" | "">(presetHead ?? "");
  useEffect(() => { if (open) setPrimaryHead(presetHead ?? ""); }, [open, presetHead]);
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

  const isDeposit = primaryHead === "security_deposit";

  // The customer's live contracts: one attaches by itself, several must be
  // chosen, none means the invoice lives on the ad-hoc page only.
  const [liveContracts, setLiveContracts] = useState<Array<{ id: string; contract_number: string; location?: { name: string } | null }>>([]);
  const [chosenContractId, setChosenContractId] = useState("");
  useEffect(() => {
    if (!open || contractId) return;
    let cancelled = false;
    setChosenContractId("");
    fetch(`/api/contracts?lead_id=${leadId}&status=active,renewal_in_progress&limit=50`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled) return;
        const rows = (json?.data ?? []) as Array<{ id: string; contract_number: string; status: string; end_date: string; location?: { name: string } | null }>;
        setLiveContracts(rows.filter(isContractOperational));
      })
      .catch(() => { if (!cancelled) setLiveContracts([]); });
    return () => { cancelled = true; };
  }, [open, leadId, contractId]);

  const resetForm = () => {
    setPrimaryHead(presetHead ?? "");
    setTitle("");
    setItems([{ description: "", quantity: 1, unit_price: 0, total: 0 }]);
    setTaxPercentage(18);
    setDiscountPercentage(0);
    setDueDate("");
    setNotes("");
    setInternalNotes("");
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

    if (!contractId && liveContracts.length > 1 && !chosenContractId) {
      toast.error("Choose which contract this invoice belongs to");
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

    // Advisory only: surfaces the AI's note-quality read as an alert, but never
    // blocks submission — accounts can still create the invoice as-is.
    // TODO: this used to be a mandatory gate; temporarily relaxed to alert-only.
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
          alert(checkJson.reason || "This note doesn't give accounts enough context — add specifics.");
        }
      }
    } catch {
      // Network failure — advisory only, don't block on it.
    }

    const body = {
      lead_id: leadId,
      proposal_id: proposalId || undefined,
      contract_id: contractId || chosenContractId || undefined,
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
      const created = await res.json().catch(() => null);
      toast.success("Invoice created successfully");
      resetForm();
      onOpenChange(false);
      onSuccess();
      if (created?.data?.id) await onCreated?.({ id: created.data.id });
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
        <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-6">
          {presetHead ? (
            <div className="space-y-1">
              <Label>What is this invoice for?</Label>
              <p className="text-sm font-medium">{ACCOUNTING_HEAD_LABELS[presetHead]}</p>
              <p className="text-xs text-muted-foreground">Set by the Invoice wizard.</p>
            </div>
          ) : (
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
  
          )}

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
              {!contractId && liveContracts.length === 1 && (
                <p className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  This customer has a live contract, so this invoice will also appear on{" "}
                  <span className="font-mono font-medium">{liveContracts[0].contract_number}</span>.
                </p>
              )}
              {!contractId && liveContracts.length > 1 && (
                <div className="space-y-2">
                  <Label htmlFor="invoice-contract">
                    Which contract is this for? <span className="text-destructive">*</span>
                  </Label>
                  <Select value={chosenContractId} onValueChange={setChosenContractId}>
                    <SelectTrigger id="invoice-contract">
                      <SelectValue placeholder="Select a live contract" />
                    </SelectTrigger>
                    <SelectContent>
                      {liveContracts.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.contract_number}{c.location?.name ? ` · ${c.location.name}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    The customer has more than one live contract. The invoice will appear on the one you pick.
                  </p>
                </div>
              )}

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
                  onChange={(e) => setInternalNotes(e.target.value)}
                  placeholder={
                    primaryHead === "unsure"
                      ? "Describe what this is for so accounts can figure out the right head — never shown to the customer"
                      : "Why this invoice exists and how accounts should book it — never shown to the customer"
                  }
                  rows={2}
                />
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
