"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";

export interface LineItemData {
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

interface LineItemsEditorProps {
  items: LineItemData[];
  onChange: (items: LineItemData[]) => void;
  taxPercentage: number;
  onTaxChange: (val: number) => void;
  discountPercentage: number;
  onDiscountChange: (val: number) => void;
}

export function LineItemsEditor({
  items,
  onChange,
  taxPercentage,
  onTaxChange,
  discountPercentage,
  onDiscountChange,
}: LineItemsEditorProps) {
  const addItem = () => {
    onChange([...items, { description: "", quantity: 1, unit_price: 0, total: 0 }]);
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, field: keyof LineItemData, value: string | number) => {
    const updated = [...items];
    const item = { ...updated[index] };

    if (field === "description") {
      item.description = value as string;
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
      {/* Header */}
      <div className="grid grid-cols-12 gap-2 text-xs font-medium text-muted-foreground px-1">
        <div className="col-span-5">Description</div>
        <div className="col-span-2">Qty</div>
        <div className="col-span-2">Unit Price</div>
        <div className="col-span-2 text-right">Total</div>
        <div className="col-span-1" />
      </div>

      {/* Items */}
      {items.map((item, index) => (
        <div key={index} className="grid grid-cols-12 gap-2 items-center">
          <div className="col-span-5">
            <Input
              placeholder="Item description"
              value={item.description}
              onChange={(e) => updateItem(index, "description", e.target.value)}
            />
          </div>
          <div className="col-span-2">
            <Input
              type="number"
              min={1}
              value={item.quantity || ""}
              onChange={(e) => updateItem(index, "quantity", e.target.value)}
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

      <Button type="button" variant="outline" size="sm" onClick={addItem}>
        <Plus className="mr-2 h-4 w-4" />
        Add Item
      </Button>

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
