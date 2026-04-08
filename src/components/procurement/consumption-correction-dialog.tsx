"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { ConsumptionLog, ConsumptionLogItem, CorrectionType } from "@/types";
import { CORRECTION_TYPE_LABELS } from "@/lib/constants";

interface CorrectionDialogProps {
  log: ConsumptionLog | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

interface RelogItem {
  item_name: string;
  quantity: string;
  unit: string;
  notes: string;
}

export function ConsumptionCorrectionDialog({
  log,
  open,
  onOpenChange,
  onSuccess,
}: CorrectionDialogProps) {
  const [correctionType, setCorrectionType] = useState<CorrectionType>("void");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Adjust state: edited quantities per line item
  const [adjustedQtys, setAdjustedQtys] = useState<Record<string, string>>({});

  // Relog state: new items to log
  const [relogItems, setRelogItems] = useState<RelogItem[]>([
    { item_name: "", quantity: "", unit: "", notes: "" },
  ]);

  // Reset state when dialog opens/closes or log changes
  useEffect(() => {
    if (open && log) {
      setCorrectionType("void");
      setReason("");
      setAdjustedQtys({});
      // Initialize adjusted quantities from original
      const qtys: Record<string, string> = {};
      log.consumption_log_items?.forEach((item) => {
        qtys[item.id] = String(item.quantity_consumed);
      });
      setAdjustedQtys(qtys);
      setRelogItems([{ item_name: "", quantity: "", unit: "", notes: "" }]);
    }
  }, [open, log]);

  if (!log) return null;

  const reasonValid = reason.trim().length >= 5;

  const handleSubmit = async () => {
    if (!reasonValid) {
      toast.error("Reason must be at least 5 characters");
      return;
    }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        action: correctionType,
        reason,
      };

      if (correctionType === "adjust") {
        body.adjustments = Object.entries(adjustedQtys).map(([itemId, qty]) => ({
          consumption_log_item_id: itemId,
          new_quantity: parseFloat(qty),
        }));
      }

      if (correctionType === "relog") {
        const validRelogItems = relogItems.filter(
          (item) => item.item_name && item.quantity && parseFloat(item.quantity) > 0
        );
        body.new_items = validRelogItems.map((item) => ({
          item_name: item.item_name,
          quantity_consumed: parseFloat(item.quantity),
          unit: item.unit,
          notes: item.notes || undefined,
        }));
      }

      const res = await fetch(`/api/procurement/consumption/${log.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to apply correction");

      toast.success("Correction applied successfully");
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to apply correction");
    } finally {
      setSubmitting(false);
    }
  };

  const addRelogItem = () => {
    setRelogItems((prev) => [...prev, { item_name: "", quantity: "", unit: "", notes: "" }]);
  };

  const removeRelogItem = (index: number) => {
    setRelogItems((prev) => prev.filter((_, i) => i !== index));
  };

  const updateRelogItem = (index: number, field: keyof RelogItem, value: string) => {
    setRelogItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: value } : item))
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Correct Consumption Log</DialogTitle>
        </DialogHeader>

        {/* Original log info */}
        <div className="rounded-lg border p-3 text-sm space-y-1 bg-muted/30">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Date</span>
            <span>{formatDate(log.logged_at)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Location</span>
            <span>{log.locations?.name || "—"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Logged By</span>
            <span>{log.logger?.full_name || "—"}</span>
          </div>
        </div>

        {/* Correction type selector */}
        <div className="space-y-2">
          <Label>Correction Type</Label>
          <Select
            value={correctionType}
            onValueChange={(v) => setCorrectionType(v as CorrectionType)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.entries(CORRECTION_TYPE_LABELS) as [string, string][]).map(
                ([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                )
              )}
            </SelectContent>
          </Select>
        </div>

        {/* VOID section */}
        {correctionType === "void" && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                This will restore all consumed quantities back to inventory.
              </span>
            </div>
            <div className="space-y-2">
              <Label>Reason *</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this entry being voided? (min 5 characters)"
                rows={3}
              />
            </div>
          </div>
        )}

        {/* ADJUST section */}
        {correctionType === "adjust" && (
          <div className="space-y-3">
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-2 font-medium">Item</th>
                    <th className="text-left p-2 font-medium">Original Qty</th>
                    <th className="text-left p-2 font-medium w-28">New Qty</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {log.consumption_log_items?.map((item) => (
                    <tr key={item.id}>
                      <td className="p-2">{item.item_name}</td>
                      <td className="p-2 text-muted-foreground">
                        {item.quantity_consumed} {item.unit}
                      </td>
                      <td className="p-2">
                        <Input
                          type="number"
                          min={0}
                          step="any"
                          value={adjustedQtys[item.id] || ""}
                          onChange={(e) =>
                            setAdjustedQtys((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                          className="h-8"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-2">
              <Label>Reason *</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why are quantities being adjusted? (min 5 characters)"
                rows={3}
              />
            </div>
          </div>
        )}

        {/* RELOG section */}
        {correctionType === "relog" && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                This will void the current entry and create a new log with the items below.
              </span>
            </div>

            {/* Original items summary */}
            <div className="text-sm">
              <p className="font-medium mb-1">Items being voided:</p>
              <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                {log.consumption_log_items?.map((item) => (
                  <li key={item.id}>
                    {item.item_name} — {item.quantity_consumed} {item.unit}
                  </li>
                ))}
              </ul>
            </div>

            {/* New items */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>New Items</Label>
                <Button variant="outline" size="sm" onClick={addRelogItem}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add Item
                </Button>
              </div>
              <div className="space-y-2">
                {relogItems.map((item, index) => (
                  <div key={index} className="flex items-center gap-2 border rounded-lg p-2">
                    <Input
                      placeholder="Item name"
                      value={item.item_name}
                      onChange={(e) => updateRelogItem(index, "item_name", e.target.value)}
                      className="h-8 flex-1"
                    />
                    <Input
                      type="number"
                      placeholder="Qty"
                      min={0}
                      step="any"
                      value={item.quantity}
                      onChange={(e) => updateRelogItem(index, "quantity", e.target.value)}
                      className="h-8 w-20"
                    />
                    <Input
                      placeholder="Unit"
                      value={item.unit}
                      onChange={(e) => updateRelogItem(index, "unit", e.target.value)}
                      className="h-8 w-20"
                    />
                    <Input
                      placeholder="Notes"
                      value={item.notes}
                      onChange={(e) => updateRelogItem(index, "notes", e.target.value)}
                      className="h-8 w-28"
                    />
                    {relogItems.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={() => removeRelogItem(index)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Reason *</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this entry being re-logged? (min 5 characters)"
                rows={3}
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant={correctionType === "void" || correctionType === "relog" ? "destructive" : "default"}
            onClick={handleSubmit}
            disabled={submitting || !reasonValid}
          >
            {submitting && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {correctionType === "void" && "Void Entry"}
            {correctionType === "adjust" && "Apply Adjustment"}
            {correctionType === "relog" && "Void & Re-log"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
