"use client";

import { useState } from "react";
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
import { LineItemsEditor, type LineItemData } from "@/components/shared/line-items-editor";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_PROPOSAL_TERMS } from "@/lib/constants";
import { LocationSelector } from "@/components/shared/location-selector";

interface ProposalFormProps {
  leadId: string;
  leadLocationId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function ProposalForm({
  leadId,
  leadLocationId,
  open,
  onOpenChange,
  onSuccess,
}: ProposalFormProps) {
  const [title, setTitle] = useState("");
  const [locationId, setLocationId] = useState<string | null>(leadLocationId || null);
  const [description, setDescription] = useState("");
  const [complimentaryItems, setComplimentaryItems] = useState([
    { name: "Complimentary Printouts", unit: "nos", quantity: 0 },
    { name: "Complimentary Conference Hall", unit: "hours", quantity: 0 },
    { name: "Meeting Room", unit: "hours", quantity: 0 },
  ]);
  const [items, setItems] = useState<LineItemData[]>([
    { description: "", quantity: 1, unit_price: 0, total: 0 },
  ]);
  const [taxPercentage, setTaxPercentage] = useState(18);
  const [discountPercentage, setDiscountPercentage] = useState(0);
  const [validUntil, setValidUntil] = useState("");
  const [termsAndConditions, setTermsAndConditions] = useState(DEFAULT_PROPOSAL_TERMS);
  const [notes, setNotes] = useState("");
  const [depositMonths, setDepositMonths] = useState(0);
  const [depositAmount, setDepositAmount] = useState(0);
  const [depositOverridden, setDepositOverridden] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Compute subtotal for deposit auto-calculation
  const computedSubtotal = items
    .filter((item) => item.description.trim())
    .reduce((sum, item) => sum + Math.max(1, item.quantity) * item.unit_price, 0);

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setItems([{ description: "", quantity: 1, unit_price: 0, total: 0 }]);
    setTaxPercentage(18);
    setDiscountPercentage(0);
    setValidUntil("");
    setTermsAndConditions(DEFAULT_PROPOSAL_TERMS);
    setNotes("");
    setLocationId(leadLocationId || null);
    setComplimentaryItems([
      { name: "Complimentary Printouts", unit: "nos", quantity: 0 },
      { name: "Complimentary Conference Hall", unit: "hours", quantity: 0 },
      { name: "Meeting Room", unit: "hours", quantity: 0 },
    ]);
    setDepositMonths(0);
    setDepositAmount(0);
    setDepositOverridden(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      toast.error("Please enter a proposal title");
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

    // Build complimentary text for PDF backward compat
    const activeComplimentary = complimentaryItems.filter(ci => ci.quantity > 0);
    const complimentaryText = activeComplimentary
      .map(ci => `${ci.name}: ${ci.quantity} ${ci.unit}/month`)
      .join("\n");

    const body = {
      lead_id: leadId,
      location_id: locationId || undefined,
      title: title.trim(),
      description: complimentaryText || description.trim() || undefined,
      items: validItems.map((item) => ({
        description: item.description,
        quantity: Math.max(1, item.quantity),
        unit: item.unit || undefined,
        unit_price: item.unit_price,
        total: Math.max(1, item.quantity) * item.unit_price,
      })),
      tax_percentage: taxPercentage,
      discount_percentage: discountPercentage,
      valid_until: validUntil || undefined,
      terms_and_conditions: termsAndConditions.trim() || undefined,
      notes: notes.trim() || undefined,
      complimentary_items: activeComplimentary.length > 0 ? activeComplimentary : undefined,
      security_deposit_months: depositMonths,
      security_deposit_amount: depositMonths > 0 ? depositAmount : 0,
    };

    const res = await fetch("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setSubmitting(false);
    if (res.ok) {
      toast.success("Proposal created successfully");
      resetForm();
      onOpenChange(false);
      onSuccess();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to create proposal");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Proposal</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="proposal-title">
                Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="proposal-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Private Office - 15 Seats"
              />
            </div>
            <div className="space-y-2">
              <Label>Location</Label>
              <LocationSelector
                value={locationId}
                onValueChange={setLocationId}
                placeholder="Select center"
              />
            </div>
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

          {/* Complimentary Services — structured line items */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold">Complimentary Services (per month)</Label>
              <button
                type="button"
                className="text-xs text-primary underline"
                onClick={() => setComplimentaryItems([...complimentaryItems, { name: "", unit: "nos", quantity: 0 }])}
              >
                + Add service
              </button>
            </div>
            <div className="space-y-2">
              {complimentaryItems.map((ci, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-6">
                    <Input
                      placeholder="Service name"
                      value={ci.name}
                      onChange={(e) => {
                        const updated = [...complimentaryItems];
                        updated[idx] = { ...ci, name: e.target.value };
                        setComplimentaryItems(updated);
                      }}
                      className="text-sm h-9"
                    />
                  </div>
                  <div className="col-span-2">
                    <Input
                      type="number"
                      placeholder="Qty"
                      value={ci.quantity || ""}
                      onChange={(e) => {
                        const updated = [...complimentaryItems];
                        updated[idx] = { ...ci, quantity: parseInt(e.target.value) || 0 };
                        setComplimentaryItems(updated);
                      }}
                      className="text-sm h-9"
                    />
                  </div>
                  <div className="col-span-3">
                    <Select
                      value={ci.unit}
                      onValueChange={(v) => {
                        const updated = [...complimentaryItems];
                        updated[idx] = { ...ci, unit: v };
                        setComplimentaryItems(updated);
                      }}
                    >
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="nos">nos</SelectItem>
                        <SelectItem value="hours">hours</SelectItem>
                        <SelectItem value="days">days</SelectItem>
                        <SelectItem value="pages">pages</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-1 flex justify-center">
                    {idx >= 3 && (
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-destructive text-xs"
                        onClick={() => setComplimentaryItems(complimentaryItems.filter((_, i) => i !== idx))}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Usage beyond these quantities will be charged to the customer.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="valid-until">Valid Until</Label>
              <Input
                id="valid-until"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </div>
          </div>

          {/* Security Deposit */}
          <div className="border rounded-lg p-4 space-y-3 bg-muted/30">
            <Label className="text-sm font-semibold">Security Deposit</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="deposit-months" className="text-xs text-muted-foreground">Number of Months</Label>
                <Select
                  value={String(depositMonths)}
                  onValueChange={(v) => {
                    const months = parseInt(v);
                    setDepositMonths(months);
                    if (!depositOverridden) {
                      setDepositAmount(months * computedSubtotal);
                    }
                  }}
                >
                  <SelectTrigger id="deposit-months">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">No deposit</SelectItem>
                    <SelectItem value="1">1 month</SelectItem>
                    <SelectItem value="2">2 months</SelectItem>
                    <SelectItem value="3">3 months</SelectItem>
                    <SelectItem value="4">4 months</SelectItem>
                    <SelectItem value="5">5 months</SelectItem>
                    <SelectItem value="6">6 months</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {depositMonths > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="deposit-amount" className="text-xs text-muted-foreground">
                    Deposit Amount (pre-GST)
                    {!depositOverridden && computedSubtotal > 0 && (
                      <span className="ml-1 text-muted-foreground">= {depositMonths} × ₹{computedSubtotal.toLocaleString("en-IN")}</span>
                    )}
                  </Label>
                  <Input
                    id="deposit-amount"
                    type="number"
                    value={depositAmount || ""}
                    onChange={(e) => {
                      setDepositAmount(parseFloat(e.target.value) || 0);
                      setDepositOverridden(true);
                    }}
                    placeholder="0"
                  />
                  {depositOverridden && (
                    <button
                      type="button"
                      className="text-xs text-primary underline"
                      onClick={() => {
                        setDepositOverridden(false);
                        setDepositAmount(depositMonths * computedSubtotal);
                      }}
                    >
                      Reset to auto-calculated
                    </button>
                  )}
                </div>
              )}
            </div>
            {depositMonths > 0 && (
              <p className="text-xs text-muted-foreground">
                Refundable deposit. A separate payment link will be generated after proposal acceptance.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="terms">Terms & Conditions</Label>
            <Textarea
              id="terms"
              value={termsAndConditions}
              onChange={(e) => setTermsAndConditions(e.target.value)}
              placeholder="Add terms and conditions..."
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="proposal-notes">Customer Notes</Label>
            <Textarea
              id="proposal-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes visible to the customer..."
              rows={2}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create Proposal
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
