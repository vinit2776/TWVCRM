"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, Plus, Trash2, Loader2, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import type { Location, LocationStock } from "@/types";

interface LineItem {
  id: string;
  item_id: string;
  item_name: string;
  quantity: string;
  unit: string;
  notes: string;
  stock_at_source: number | null;
}

function generateLocalId() {
  return Math.random().toString(36).slice(2);
}

const emptyItem = (): LineItem => ({
  id: generateLocalId(),
  item_id: "",
  item_name: "",
  quantity: "",
  unit: "",
  notes: "",
  stock_at_source: null,
});

interface CatalogItem {
  id: string;
  name: string;
  unit: string;
  department: string;
}

export default function NewTransferPage() {
  const router = useRouter();

  const [fromLocationId, setFromLocationId] = useState("");
  const [toLocationId, setToLocationId] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([emptyItem()]);
  const [submitting, setSubmitting] = useState(false);

  const [locations, setLocations] = useState<Location[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [sourceStock, setSourceStock] = useState<LocationStock[]>([]);

  // Fetch locations and catalog items on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/locations").then((r) => r.json()),
      fetch("/api/procurement/items?item_type=goods").then((r) => r.json()),
    ]).then(([locJson, itemJson]) => {
      const locs = (locJson.data || []).filter((l: Location) => l.is_active !== false);
      setLocations(locs);
      setCatalogItems(itemJson.data || []);
    });
  }, []);

  // Fetch source location stock when from_location changes
  const fetchSourceStock = useCallback(async () => {
    if (!fromLocationId) { setSourceStock([]); return; }
    const res = await fetch(`/api/procurement/inventory?location_id=${fromLocationId}`);
    if (res.ok) {
      const json = await res.json();
      setSourceStock(json.data || []);
    }
  }, [fromLocationId]);

  useEffect(() => { fetchSourceStock(); }, [fetchSourceStock]);

  // When source stock loads or items change, update stock info per line item
  useEffect(() => {
    if (sourceStock.length === 0) return;
    setItems((prev) =>
      prev.map((li) => {
        if (!li.item_id) return li;
        const found = sourceStock.find((s) => s.item_id === li.item_id);
        return { ...li, stock_at_source: found ? found.quantity_on_hand : 0 };
      })
    );
  }, [sourceStock]);

  const toLocations = locations.filter((l) => l.id !== fromLocationId);

  const updateItem = (localId: string, field: keyof LineItem, value: string) => {
    setItems((prev) =>
      prev.map((li) => {
        if (li.id !== localId) return li;
        const updated = { ...li, [field]: value };
        // When item_id changes, auto-fill name, unit, and stock
        if (field === "item_id" && value) {
          const cat = catalogItems.find((c) => c.id === value);
          if (cat) {
            updated.item_name = cat.name;
            updated.unit = cat.unit;
          }
          const stockEntry = sourceStock.find((s) => s.item_id === value);
          updated.stock_at_source = stockEntry ? stockEntry.quantity_on_hand : 0;
        }
        return updated;
      })
    );
  };

  const removeItem = (localId: string) => {
    if (items.length <= 1) {
      toast.error("At least one item is required");
      return;
    }
    setItems(items.filter((li) => li.id !== localId));
  };

  const validate = (): string | null => {
    if (!fromLocationId) return "Please select a source location";
    if (!toLocationId) return "Please select a destination location";
    if (fromLocationId === toLocationId) return "Source and destination must be different";
    const validItems = items.filter((li) => li.item_name.trim() && parseFloat(li.quantity) > 0);
    if (validItems.length === 0) return "At least one item with a valid quantity is required";
    for (const li of validItems) {
      if (!li.item_name.trim()) return "All items must have a name";
      if (!li.quantity || isNaN(parseFloat(li.quantity)) || parseFloat(li.quantity) <= 0) {
        return `"${li.item_name}": quantity must be greater than 0`;
      }
      if (!li.unit) return `"${li.item_name}": unit is required`;
    }
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }

    setSubmitting(true);
    try {
      const validItems = items.filter((li) => li.item_name.trim() && parseFloat(li.quantity) > 0);
      const payload = {
        from_location_id: fromLocationId,
        to_location_id: toLocationId,
        notes: notes.trim() || undefined,
        items: validItems.map((li) => ({
          item_id: li.item_id || undefined,
          item_name: li.item_name.trim(),
          unit: li.unit,
          quantity_sent: parseFloat(li.quantity),
        })),
      };

      const res = await fetch("/api/procurement/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Failed to create transfer");
        return;
      }
      toast.success(`Transfer created — ${json.data.transfer_number}`);
      router.push(`/procurement/transfers/${json.data.id}`);
    } finally {
      setSubmitting(false);
    }
  };

  const totalItems = items.filter((li) => li.item_name.trim() && parseFloat(li.quantity) > 0).length;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push("/procurement/transfers")}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Stock Transfer</h1>
          <p className="text-sm text-muted-foreground">
            Move inventory between locations
          </p>
        </div>
      </div>

      {/* Transfer Details */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Transfer Details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="from_location">From Location <span className="text-red-500">*</span></Label>
            <Select
              value={fromLocationId || "__none__"}
              onValueChange={(v) => {
                const val = v === "__none__" ? "" : v;
                setFromLocationId(val);
                // Reset to_location if it matches the new from
                if (val && val === toLocationId) setToLocationId("");
              }}
            >
              <SelectTrigger id="from_location">
                <SelectValue placeholder="Select source location" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Select source location</SelectItem>
                {locations.map((loc) => (
                  <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="to_location">To Location <span className="text-red-500">*</span></Label>
            <Select
              value={toLocationId || "__none__"}
              onValueChange={(v) => setToLocationId(v === "__none__" ? "" : v)}
            >
              <SelectTrigger id="to_location">
                <SelectValue placeholder="Select destination location" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Select destination location</SelectItem>
                {toLocations.map((loc) => (
                  <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              placeholder="Any additional notes for this transfer..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
            />
          </div>
        </CardContent>
      </Card>

      {/* Line Items */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">Items <span className="text-red-500">*</span></CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setItems([...items, emptyItem()])}
          >
            <Plus className="h-4 w-4 mr-1" /> Add Item
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.map((li, idx) => (
            <div key={li.id} className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Item {idx + 1}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => removeItem(li.id)}
                  disabled={items.length <= 1}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Item <span className="text-red-500">*</span></Label>
                  <Select
                    value={li.item_id || "__none__"}
                    onValueChange={(v) => updateItem(li.id, "item_id", v === "__none__" ? "" : v)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select an item" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Select an item</SelectItem>
                      {catalogItems.map((cat) => (
                        <SelectItem key={cat.id} value={cat.id}>
                          {cat.name} ({cat.unit})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Quantity <span className="text-red-500">*</span></Label>
                    <Input
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="0"
                      value={li.quantity}
                      onChange={(e) => updateItem(li.id, "quantity", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Unit</Label>
                    <Input
                      value={li.unit}
                      readOnly
                      className="bg-muted/50"
                      placeholder="Auto-filled"
                    />
                  </div>
                </div>

                {fromLocationId && li.item_id && (
                  <div className="sm:col-span-2">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Package className="h-3 w-3" />
                      Stock at source:{" "}
                      <span className={`font-medium ${
                        li.stock_at_source !== null && li.stock_at_source <= 0
                          ? "text-red-600"
                          : li.stock_at_source !== null && parseFloat(li.quantity) > li.stock_at_source
                            ? "text-amber-600"
                            : "text-foreground"
                      }`}>
                        {li.stock_at_source !== null ? li.stock_at_source : "Loading..."}
                        {li.stock_at_source !== null && li.unit ? ` ${li.unit}` : ""}
                      </span>
                      {li.stock_at_source !== null && parseFloat(li.quantity) > li.stock_at_source && (
                        <span className="text-amber-600 font-medium ml-1">(exceeds available stock)</span>
                      )}
                    </p>
                  </div>
                )}

                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">Notes (optional)</Label>
                  <Input
                    placeholder="Item-specific notes..."
                    value={li.notes}
                    onChange={(e) => updateItem(li.id, "notes", e.target.value)}
                  />
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Summary & Actions */}
      <Card>
        <CardContent className="pt-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Summary</p>
            <p className="text-lg font-semibold">{totalItems} item{totalItems !== 1 ? "s" : ""}</p>
          </div>
          <Button onClick={handleSubmit} disabled={submitting} size="lg">
            {submitting ? (
              <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Creating...</>
            ) : (
              "Create Transfer"
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
