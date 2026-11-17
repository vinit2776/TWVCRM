"use client";

import { useState } from "react";
import { Plus, Trash2, BookMarked } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { PresetPickerDialog } from "@/components/proposals/preset-picker";

export interface LineItemData {
  description: string;
  quantity: number;
  unit?: string;
  unit_price: number;
  total: number;
  /** Only set when the rent/maintenance split is on; false = fixed on renewal. */
  escalates?: boolean;
}

interface LineItemsEditorProps {
  items: LineItemData[];
  onChange: (items: LineItemData[]) => void;
  taxPercentage: number;
  onTaxChange: (val: number) => void;
  discountPercentage: number;
  onDiscountChange: (val: number) => void;
  /**
   * Opt-in rent/maintenance split. When `onEscalationSplitChange` is given the
   * editor shows the toggle and a per-line "On renewal" control. Callers that
   * don't pass it (e.g. ad-hoc invoices) see no change.
   */
  escalationSplit?: boolean;
  onEscalationSplitChange?: (on: boolean) => void;
}

export function LineItemsEditor({
  items,
  onChange,
  taxPercentage,
  onTaxChange,
  discountPercentage,
  onDiscountChange,
  escalationSplit = false,
  onEscalationSplitChange,
}: LineItemsEditorProps) {
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);

  const addFromPreset = (preset: LineItemData) => {
    onChange([...items, preset]);
  };

  const showSplit = Boolean(onEscalationSplitChange);
  const splitOn = showSplit && escalationSplit;

  // Turning the split on keeps every existing line escalating (today's
  // behaviour); staff then mark maintenance as fixed. Turning it off drops the
  // flags so the lines go back to the legacy shape.
  const toggleSplit = (on: boolean) => {
    onChange(items.map((i) => {
      const next = { ...i };
      if (on) next.escalates = true;
      else delete next.escalates;
      return next;
    }));
    onEscalationSplitChange?.(on);
  };

  const toggleEscalates = (index: number) => {
    onChange(items.map((i, idx) => (idx === index ? { ...i, escalates: i.escalates === false } : i)));
  };

  const addItem = () => {
    onChange([
      ...items,
      { description: "", quantity: 1, unit: "", unit_price: 0, total: 0, ...(splitOn ? { escalates: false } : {}) },
    ]);
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, field: keyof LineItemData, value: string | number) => {
    const updated = [...items];
    const item = { ...updated[index] };

    if (field === "description") {
      item.description = value as string;
    } else if (field === "unit") {
      item.unit = value as string;
    } else if (field === "quantity") {
      item.quantity = Number(value) || 0;
      item.total = item.quantity * item.unit_price;
    } else if (field === "unit_price") {
      item.unit_price = Number(value) || 0;
      item.total = item.quantity * item.unit_price;
    }

    updated[index] = item;
    onChange(updated);
  };

  const subtotal = items.reduce((sum, item) => sum + item.total, 0);
  const taxAmount = subtotal * (taxPercentage / 100);
  const discountAmount = subtotal * (discountPercentage / 100);
  const grandTotal = subtotal + taxAmount - discountAmount;

  return (
    <div className="space-y-4">
      {showSplit && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={splitOn} onChange={(e) => toggleSplit(e.target.checked)} />
          Rent and maintenance are billed separately (maintenance does not escalate)
        </label>
      )}

      {/* Header */}
      <div className="grid grid-cols-12 gap-2 text-xs font-medium text-muted-foreground px-1">
        <div className={splitOn ? "col-span-3" : "col-span-4"}>Description</div>
        <div className="col-span-1">Qty</div>
        <div className={splitOn ? "col-span-1" : "col-span-2"}>Unit</div>
        <div className="col-span-2">Unit Price</div>
        <div className="col-span-2 text-right">Total</div>
        {splitOn && <div className="col-span-2 text-center">On renewal</div>}
        <div className="col-span-1" />
      </div>

      {/* Items */}
      {items.map((item, index) => (
        <div key={index} className="grid grid-cols-12 gap-2 items-center">
          <div className={splitOn ? "col-span-3" : "col-span-4"}>
            <Input
              placeholder="Item description"
              value={item.description}
              onChange={(e) => updateItem(index, "description", e.target.value)}
            />
          </div>
          <div className="col-span-1">
            <Input
              type="number"
              min={1}
              value={item.quantity || ""}
              onChange={(e) => updateItem(index, "quantity", e.target.value)}
            />
          </div>
          <div className={splitOn ? "col-span-1" : "col-span-2"}>
            <Input
              placeholder="hrs, days…"
              value={item.unit || ""}
              onChange={(e) => updateItem(index, "unit", e.target.value)}
            />
          </div>
          <div className="col-span-2">
            <Input
              type="number"
              min={0}
              value={item.unit_price || ""}
              onChange={(e) => updateItem(index, "unit_price", e.target.value)}
            />
          </div>
          <div className="col-span-2 text-right text-sm font-medium">
            {formatCurrency(item.total)}
          </div>
          {splitOn && (
            <div className="col-span-2 flex justify-center">
              <button
                type="button"
                onClick={() => toggleEscalates(index)}
                className={`text-xs rounded px-2 py-1 border ${
                  item.escalates === false
                    ? "bg-amber-50 text-amber-800 border-amber-300"
                    : "bg-blue-50 text-blue-800 border-blue-300"
                }`}
                aria-label={`Toggle escalation for line ${index + 1}`}
              >
                {item.escalates === false ? "Stays fixed" : "Escalates"}
              </button>
            </div>
          )}
          <div className="col-span-1 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => removeItem(index)}
              disabled={items.length <= 1}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}

      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={addItem}>
          <Plus className="mr-2 h-4 w-4" />
          Add Item
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setPresetPickerOpen(true)}>
          <BookMarked className="mr-2 h-4 w-4" />
          From Presets
        </Button>
      </div>

      <PresetPickerDialog
        open={presetPickerOpen}
        onOpenChange={setPresetPickerOpen}
        onAddItem={addFromPreset}
      />

      {/* Totals */}
      <div className="border-t pt-4 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Subtotal</span>
          <span className="font-medium">{formatCurrency(subtotal)}</span>
        </div>
        <div className="flex items-center justify-between text-sm gap-4">
          <span className="text-muted-foreground">Tax (%)</span>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={100}
              className="w-20 h-8 text-right"
              value={taxPercentage}
              onChange={(e) => onTaxChange(Number(e.target.value) || 0)}
            />
            <span className="w-24 text-right font-medium">{formatCurrency(taxAmount)}</span>
          </div>
        </div>
        <div className="flex items-center justify-between text-sm gap-4">
          <span className="text-muted-foreground">Discount (%)</span>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={100}
              className="w-20 h-8 text-right"
              value={discountPercentage}
              onChange={(e) => onDiscountChange(Number(e.target.value) || 0)}
            />
            <span className="w-24 text-right font-medium">-{formatCurrency(discountAmount)}</span>
          </div>
        </div>
        <div className="flex justify-between text-base font-semibold border-t pt-2">
          <span>Grand Total</span>
          <span>{formatCurrency(grandTotal)}</span>
        </div>
      </div>
    </div>
  );
}
