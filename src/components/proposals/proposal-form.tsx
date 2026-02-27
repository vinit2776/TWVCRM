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
  const [items, setItems] = useState<LineItemData[]>([
    { description: "", quantity: 1, unit_price: 0, total: 0 },
  ]);
  const [taxPercentage, setTaxPercentage] = useState(18);
  const [discountPercentage, setDiscountPercentage] = useState(0);
  const [validUntil, setValidUntil] = useState("");
  const [termsAndConditions, setTermsAndConditions] = useState(DEFAULT_PROPOSAL_TERMS);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

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

    const body = {
      lead_id: leadId,
      location_id: locationId || undefined,
      title: title.trim(),
      description: description.trim() || undefined,
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
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="proposal-description">Description</Label>
              <Textarea
                id="proposal-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief proposal description..."
                rows={2}
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
            <Label htmlFor="proposal-notes">Notes</Label>
            <Textarea
              id="proposal-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Internal notes..."
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
