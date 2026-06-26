"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft, Plus, Trash2, Loader2, ArrowRight,
  AlertTriangle, CheckCircle, XCircle, Warehouse,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { STOCK_DEPARTMENTS } from "@/lib/constants";
import type { Location, LocationStock } from "@/types";

interface LineItem {
  id: string;
  item_id: string;
  item_name: string;
  quantity: string;
  unit: string;
  notes: string;
  stock_at_source: number | null;
  stock_at_dest: number | null;
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
  stock_at_dest: null,
});

interface CatalogItem {
  id: string;
  name: string;
  unit: string;
  department: string;
}

function buildStockMap(stock: LocationStock[]): Record<string, number> {
  return Object.fromEntries(
    stock.map((s) => [s.item_id, Number(s.quantity_on_hand)])
  );
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
  const [destStock, setDestStock] = useState<LocationStock[]>([]);

  const sourceStockMap = buildStockMap(sourceStock);
  const destStockMap   = buildStockMap(destStock);

  // Fetch locations + catalog on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/locations").then((r) => r.json()),
      fetch("/api/procurement/items?item_type=goods").then((r) => r.json()),
    ]).then(([locJson, itemJson]) => {
      const locs = (locJson.data || []).filter((l: Location) => l.is_active !== false);
      setLocations(locs);
      // Only physical-stock departments can be transferred (no Administration / services)
      setCatalogItems(
        (itemJson.data || []).filter((it: CatalogItem) =>
          STOCK_DEPARTMENTS.includes(it.department)
        )
      );
    });
  }, []);

  const fetchSourceStock = useCallback(async () => {
    if (!fromLocationId) { setSourceStock([]); return; }
    const res = await fetch(`/api/procurement/inventory?location_id=${fromLocationId}`);
    if (res.ok) setSourceStock((await res.json()).data || []);
  }, [fromLocationId]);

  const fetchDestStock = useCallback(async () => {
    if (!toLocationId) { setDestStock([]); return; }
    const res = await fetch(`/api/procurement/inventory?location_id=${toLocationId}`);
    if (res.ok) setDestStock((await res.json()).data || []);
  }, [toLocationId]);

  useEffect(() => { fetchSourceStock(); }, [fetchSourceStock]);
  useEffect(() => { fetchDestStock(); },  [fetchDestStock]);

  // Re-sync stock values on all line items whenever either stock set changes
  useEffect(() => {
    setItems((prev) =>
      prev.map((li) => {
        if (!li.item_id) return li;
        return {
          ...li,
          stock_at_source: sourceStockMap[li.item_id] ?? 0,
          stock_at_dest:   destStockMap[li.item_id]   ?? 0,
        };
      })
    );
    // sourceStockMap / destStockMap are re-derived every render from the
    // arrays above — only re-run this effect when the arrays themselves change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceStock, destStock]);

  const toLocations     = locations.filter((l) => l.id !== fromLocationId);
  const fromLocationName = locations.find((l) => l.id === fromLocationId)?.name ?? "Source";
  const toLocationName   = locations.find((l) => l.id === toLocationId)?.name   ?? "Destination";

  const updateItem = (localId: string, field: keyof LineItem, value: string) => {
    setItems((prev) =>
      prev.map((li) => {
        if (li.id !== localId) return li;
        const updated = { ...li, [field]: value };
        if (field === "item_id" && value) {
          const cat = catalogItems.find((c) => c.id === value);
          if (cat) { updated.item_name = cat.name; updated.unit = cat.unit; }
          updated.stock_at_source = sourceStockMap[value] ?? 0;
          updated.stock_at_dest   = destStockMap[value]   ?? 0;
        }
        return updated;
      })
    );
  };

  const removeItem = (localId: string) => {
    if (items.length <= 1) { toast.error("At least one item is required"); return; }
    setItems(items.filter((li) => li.id !== localId));
  };

  const validate = (): string | null => {
    if (!fromLocationId) return "Please select a source location";
    if (!toLocationId)   return "Please select a destination location";
    if (fromLocationId === toLocationId) return "Source and destination must be different";
    const valid = items.filter((li) => li.item_name.trim() && parseFloat(li.quantity) > 0);
    if (valid.length === 0) return "At least one item with a valid quantity is required";
    for (const li of valid) {
      if (!li.quantity || parseFloat(li.quantity) <= 0)
        return `"${li.item_name}": quantity must be greater than 0`;
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
      const res = await fetch("/api/procurement/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_location_id: fromLocationId,
          to_location_id:   toLocationId,
          notes: notes.trim() || undefined,
          items: validItems.map((li) => ({
            item_id:       li.item_id || undefined,
            item_name:     li.item_name.trim(),
            unit:          li.unit,
            quantity_sent: parseFloat(li.quantity),
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(typeof json.error === "string" ? json.error : "Failed to create transfer"); return; }
      toast.success(`Transfer created — ${json.data.transfer_number}`);
      router.push(`/procurement/transfers/${json.data.id}`);
    } finally {
      setSubmitting(false);
    }
  };

  const totalItems = items.filter((li) => li.item_name.trim() && parseFloat(li.quantity) > 0).length;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* ── Header ── */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.push("/procurement/transfers")}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Stock Transfer</h1>
          <p className="text-sm text-muted-foreground">Move inventory between locations</p>
        </div>
      </div>

      {/* ── Transfer Details ── */}
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

          {/* Route banner */}
          {fromLocationId && toLocationId && (
            <div className="sm:col-span-2 flex items-center gap-3 rounded-lg bg-muted/40 border px-4 py-2.5">
              <Warehouse className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-sm font-medium">{fromLocationName}</span>
              <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
              <Warehouse className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-sm font-medium">{toLocationName}</span>
            </div>
          )}

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

      {/* ── Line Items ── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">Items <span className="text-red-500">*</span></CardTitle>
          <Button variant="outline" size="sm" onClick={() => setItems([...items, emptyItem()])}>
            <Plus className="h-4 w-4 mr-1" /> Add Item
          </Button>
        </CardHeader>

        <CardContent className="space-y-4">
          {items.map((li, idx) => {
            const qty       = parseFloat(li.quantity) || 0;
            const srcQty    = li.stock_at_source ?? 0;
            const destQty   = li.stock_at_dest   ?? 0;
            const srcLoaded = li.stock_at_source !== null;
            const destLoaded = li.stock_at_dest  !== null;
            const srcEmpty  = srcLoaded && srcQty === 0;
            const srcShort  = srcLoaded && qty > 0 && qty > srcQty;
            const destAfter = destQty + qty;

            return (
              <div key={li.id} className="border rounded-lg overflow-hidden">
                {/* Item header */}
                <div className="flex items-center justify-between px-4 py-2.5 bg-muted/30 border-b">
                  <span className="text-sm font-semibold text-muted-foreground">Item {idx + 1}</span>
                  <Button
                    variant="ghost" size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => removeItem(li.id)}
                    disabled={items.length <= 1}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <div className="p-4 space-y-3">
                  {/* Item selector */}
                  <div className="space-y-1">
                    <Label className="text-xs">Item <span className="text-red-500">*</span></Label>
                    <SearchableSelect
                      options={catalogItems.map((cat) => {
                        const inStock = sourceStockMap[cat.id] ?? 0;
                        const stockHint = fromLocationId
                          ? inStock > 0
                            ? ` — ${inStock} ${cat.unit}`
                            : " — no stock"
                          : "";
                        return { value: cat.id, label: `${cat.name}${stockHint}` };
                      })}
                      value={li.item_id || ""}
                      onValueChange={(v) => updateItem(li.id, "item_id", v)}
                      placeholder="Select an item"
                      searchPlaceholder="Search items…"
                      emptyMessage="No matching items"
                    />
                  </div>

                  {/* ── Stock display — shown as soon as item is selected ── */}
                  {li.item_id && fromLocationId && (
                    <div className="grid grid-cols-2 gap-0 rounded-lg border overflow-hidden text-sm">

                      {/* SOURCE side */}
                      <div className={`p-3 ${
                        srcEmpty  ? "bg-red-50 border-red-200"
                        : srcShort ? "bg-amber-50 border-amber-200"
                        : srcLoaded ? "bg-green-50"
                        : "bg-muted/30"
                      }`}>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                          <span className="inline-block w-2 h-2 rounded-full bg-current opacity-60" />
                          FROM · {fromLocationName}
                        </p>

                        {srcLoaded ? (
                          <>
                            <div className="flex items-baseline gap-1.5">
                              {srcEmpty ? (
                                <XCircle className="h-4 w-4 text-red-500 shrink-0" />
                              ) : srcShort ? (
                                <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                              ) : (
                                <CheckCircle className="h-4 w-4 text-green-600 shrink-0" />
                              )}
                              <span className={`text-xl font-bold tabular-nums ${
                                srcEmpty  ? "text-red-600"
                                : srcShort ? "text-amber-600"
                                : "text-green-700"
                              }`}>
                                {srcQty}
                              </span>
                              <span className="text-xs text-muted-foreground">{li.unit} on hand</span>
                            </div>

                            {srcEmpty && (
                              <Badge className="mt-1.5 text-[10px] bg-red-100 text-red-700 border-0">
                                Out of stock
                              </Badge>
                            )}
                            {srcShort && qty > 0 && (
                              <Badge className="mt-1.5 text-[10px] bg-amber-100 text-amber-800 border-0">
                                Short by {qty - srcQty} {li.unit}
                              </Badge>
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-muted-foreground">Loading...</p>
                        )}
                      </div>

                      {/* DESTINATION side */}
                      <div className="p-3 bg-blue-50/60 border-l">
                        <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                          <span className="inline-block w-2 h-2 rounded-full bg-current opacity-60" />
                          TO · {toLocationId ? toLocationName : "—"}
                        </p>

                        {!toLocationId ? (
                          <p className="text-xs text-muted-foreground italic">
                            Select a destination to see its current stock
                          </p>
                        ) : destLoaded ? (
                          <>
                            <div className="flex items-baseline gap-1.5">
                              <span className="text-xl font-bold tabular-nums text-blue-700">
                                {destQty}
                              </span>
                              <span className="text-xs text-muted-foreground">{li.unit} on hand</span>
                            </div>
                            {qty > 0 && (
                              <div className="mt-1.5 flex items-center gap-1 text-xs text-blue-600 font-medium">
                                <ArrowRight className="h-3 w-3 shrink-0" />
                                {destAfter} {li.unit} after transfer
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-muted-foreground">Loading...</p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Quantity + Unit */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Qty to Transfer <span className="text-red-500">*</span></Label>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        placeholder="0"
                        value={li.quantity}
                        onChange={(e) => updateItem(li.id, "quantity", e.target.value)}
                        className={srcShort && qty > 0 ? "border-amber-400 focus-visible:ring-amber-300" : ""}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Unit</Label>
                      <Input value={li.unit} readOnly className="bg-muted/50" placeholder="Auto-filled" />
                    </div>
                  </div>

                  {/* Notes */}
                  <div className="space-y-1">
                    <Label className="text-xs">Notes (optional)</Label>
                    <Input
                      placeholder="Item-specific notes..."
                      value={li.notes}
                      onChange={(e) => updateItem(li.id, "notes", e.target.value)}
                    />
                  </div>
                </div>
              </div>
            );
          })}

          {/* Bottom add button */}
          <Button
            variant="outline"
            className="w-full border-dashed"
            onClick={() => setItems([...items, emptyItem()])}
          >
            <Plus className="h-4 w-4 mr-1" /> Add Another Item
          </Button>
        </CardContent>
      </Card>

      {/* ── Summary & Actions ── */}
      <Card>
        <CardContent className="pt-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Summary</p>
            <p className="text-lg font-semibold">
              {totalItems} item{totalItems !== 1 ? "s" : ""} to transfer
            </p>
            {fromLocationId && toLocationId && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {fromLocationName} → {toLocationName}
              </p>
            )}
          </div>
          <Button onClick={handleSubmit} disabled={submitting} size="lg">
            {submitting
              ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Creating...</>
              : "Create Transfer"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
