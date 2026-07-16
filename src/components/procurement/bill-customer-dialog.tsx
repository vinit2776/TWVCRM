"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface BillLineItem {
  id: string; // local draft id
  description: string;
  quantity: string;
  unit_price: string;
}

function generateLocalId() {
  return Math.random().toString(36).slice(2);
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prId: string;
  prNumber: string;
  contractLabel: string;
  /** Pre-fills the line-item editor from the MR's own items — pricing is entered fresh, not copied. */
  seedItems: { item_name: string; quantity: number }[];
  onSuccess: () => void;
};

export function BillCustomerDialog({
  open, onOpenChange, prId, prNumber, contractLabel, seedItems, onSuccess,
}: Props) {
  const [items, setItems] = useState<BillLineItem[]>([]);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setItems(
      seedItems.length > 0
        ? seedItems.map((it) => ({
            id: generateLocalId(),
            description: it.item_name,
            quantity: String(it.quantity ?? 1),
            unit_price: "",
          }))
        : [{ id: generateLocalId(), description: "", quantity: "1", unit_price: "" }]
    );
    setNotes("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const addItem = () => {
    setItems((prev) => [...prev, { id: generateLocalId(), description: "", quantity: "1", unit_price: "" }]);
  };

  const removeItem = (localId: string) => {
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((li) => li.id !== localId)));
  };

  const updateItem = (localId: string, field: keyof BillLineItem, value: string) => {
    setItems((prev) => prev.map((li) => (li.id === localId ? { ...li, [field]: value } : li)));
  };

  const subtotal = items.reduce((sum, li) => {
    const q = parseFloat(li.quantity);
    const p = parseFloat(li.unit_price);
    if (!isNaN(q) && !isNaN(p)) return sum + q * p;
    return sum;
  }, 0);

  const handleSubmit = async () => {
    const cleanedItems = items
      .map((li) => ({
        description: li.description.trim(),
        quantity: parseFloat(li.quantity),
        unit_price: parseFloat(li.unit_price),
      }))
      .filter((li) => li.description && !isNaN(li.quantity) && li.quantity > 0 && !isNaN(li.unit_price) && li.unit_price >= 0);

    if (cleanedItems.length === 0) {
      toast.error("Add at least one line item with a description, quantity, and price");
      return;
    }
    if (subtotal <= 0) {
      toast.error("Total amount must be greater than zero");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/procurement/requests/${prId}/bill-customer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: cleanedItems, notes: notes.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to create invoice");
        return;
      }

      // Finalize + dispatch immediately — same one-click behaviour as the
      // Usage tab's "Verify & Send". Rolls back to draft on dispatch failure.
      const sendRes = await fetch(`/api/billing-statements/${json.data.id}/finalize-and-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const sendJson = await sendRes.json();
      if (!sendRes.ok) {
        toast.error(
          `Invoice ${json.data.statement_number} created but sending failed: ${sendJson.error || "unknown error"}. Find it as a draft on the Billing page and retry.`
        );
        onSuccess();
        onOpenChange(false);
        return;
      }

      toast.success(
        sendJson.no_contact
          ? `Invoice ${json.data.statement_number} created, but the customer has no email/phone on file — send it manually.`
          : `Invoice ${json.data.statement_number} sent to the customer (${formatCurrency(sendJson.total_amount)}).`
      );
      onSuccess();
      onOpenChange(false);
    } catch (err) {
      toast.error("Something went wrong billing the customer");
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bill Customer — {prNumber}</DialogTitle>
          <DialogDescription>
            Invoicing {contractLabel}. Enter the customer-facing price for each line — this is manually
            marked up, it does not have to match the vendor cost. You can bill this in full now, or bill
            part of it as an advance and the rest later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_80px_110px_36px] gap-2 text-xs font-medium text-muted-foreground px-1">
            <span>Description</span>
            <span>Qty</span>
            <span>Price</span>
            <span />
          </div>
          {items.map((li) => (
            <div key={li.id} className="grid grid-cols-[1fr_80px_110px_36px] gap-2 items-start">
              <Input
                placeholder="e.g. Office chairs (x4)"
                value={li.description}
                onChange={(e) => updateItem(li.id, "description", e.target.value)}
              />
              <Input
                type="number"
                min="0"
                step="0.01"
                value={li.quantity}
                onChange={(e) => updateItem(li.id, "quantity", e.target.value)}
              />
              <Input
                type="number"
                min="0"
                step="0.01"
                placeholder="Rate"
                value={li.unit_price}
                onChange={(e) => updateItem(li.id, "unit_price", e.target.value)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-red-600"
                onClick={() => removeItem(li.id)}
                disabled={items.length <= 1}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={addItem}>
            <Plus className="h-4 w-4 mr-1" /> Add line
          </Button>

          <div className="space-y-1.5 pt-2">
            <Label htmlFor="bill-customer-notes">Notes (optional)</Label>
            <Textarea
              id="bill-customer-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Internal note — not shown on the invoice"
            />
          </div>

          <div className="flex justify-end text-sm font-medium pt-2 border-t">
            Subtotal: {formatCurrency(subtotal)} <span className="text-muted-foreground font-normal ml-1">(+ GST)</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || subtotal <= 0}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Bill Customer & Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
