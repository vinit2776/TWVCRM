"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, ChevronLeft, Search, Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { ItemHistoryDialog } from "@/components/procurement/item-history-dialog";
import {
  PROCUREMENT_DEPARTMENTS, PROCUREMENT_DEPARTMENT_LABELS,
  ITEM_UNITS,
} from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import type { ProcurementItem, Location, ProcurementDepartment, ItemUnit } from "@/types";

interface LineItem {
  id: string; // local draft id
  item_id: string | null;
  item_name: string;
  quantity: string;
  unit: ItemUnit;
  estimated_price: string;
  notes: string;
}

function generateLocalId() {
  return Math.random().toString(36).slice(2);
}

const emptyItem = (): LineItem => ({
  id: generateLocalId(),
  item_id: null,
  item_name: "",
  quantity: "",
  unit: "piece",
  estimated_price: "",
  notes: "",
});

export default function NewPurchaseRequestPage() {
  const router = useRouter();
  const [department, setDepartment] = useState<ProcurementDepartment>("pantry");
  const [locationId, setLocationId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([emptyItem()]);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);

  // Catalog picker
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogItems, setCatalogItems] = useState<ProcurementItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [targetItemId, setTargetItemId] = useState<string | null>(null); // which line item we're picking for

  // Locations
  const [locations, setLocations] = useState<Location[]>([]);

  useEffect(() => {
    fetch("/api/locations").then((r) => r.json()).then((j) => setLocations(j.data || []));
  }, []);

  // Fetch catalog items when department changes or catalog opens
  useEffect(() => {
    if (!catalogOpen) return;
    setCatalogLoading(true);
    const params = new URLSearchParams({ department });
    if (catalogSearch.trim()) params.set("search", catalogSearch.trim());
    fetch(`/api/procurement/items?${params}`)
      .then((r) => r.json())
      .then((j) => setCatalogItems(j.data || []))
      .finally(() => setCatalogLoading(false));
  }, [catalogOpen, department, catalogSearch]);

  const openCatalogForItem = (localId: string) => {
    setTargetItemId(localId);
    setCatalogSearch("");
    setCatalogOpen(true);
  };

  const selectCatalogItem = (catalogItem: ProcurementItem) => {
    setItems((prev) =>
      prev.map((li) =>
        li.id === targetItemId
          ? {
              ...li,
              item_id: catalogItem.id,
              item_name: catalogItem.name,
              unit: catalogItem.unit,
              estimated_price: catalogItem.standard_price ? String(catalogItem.standard_price) : li.estimated_price,
            }
          : li
      )
    );
    setCatalogOpen(false);
  };

  const updateItem = (localId: string, field: keyof LineItem, value: string) => {
    setItems((prev) =>
      prev.map((li) => (li.id === localId ? { ...li, [field]: value } : li))
    );
  };

  const removeItem = (localId: string) => {
    if (items.length <= 1) {
      toast.error("At least one item is required");
      return;
    }
    setItems((prev) => prev.filter((li) => li.id !== localId));
  };

  const totalEstimated = items.reduce((sum, li) => {
    const q = parseFloat(li.quantity);
    const p = parseFloat(li.estimated_price);
    if (!isNaN(q) && !isNaN(p)) return sum + q * p;
    return sum;
  }, 0);

  const buildPayload = (submit: boolean) => ({
    department,
    location_id: locationId || null,
    notes: notes.trim() || undefined,
    submit,
    items: items.map((li) => ({
      item_id: li.item_id || null,
      item_name: li.item_name.trim(),
      quantity: parseFloat(li.quantity),
      unit: li.unit,
      estimated_price: li.estimated_price ? parseFloat(li.estimated_price) : null,
      notes: li.notes.trim() || undefined,
    })),
  });

  const validate = (): string | null => {
    for (const li of items) {
      if (!li.item_id) return "All items must be selected from the catalog";
      if (!li.item_name.trim()) return "All items must have a name";
      if (!li.quantity || isNaN(parseFloat(li.quantity)) || parseFloat(li.quantity) <= 0)
        return "All items must have a valid quantity";
    }
    return null;
  };

  const handleSaveDraft = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    setSavingDraft(true);
    try {
      const res = await fetch("/api/procurement/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(false)),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to save draft"); return; }
      toast.success(`Draft saved — ${json.data.pr_number}`);
      router.push(`/procurement/requests/${json.data.id}`);
    } finally {
      setSavingDraft(false);
    }
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    setSubmitting(true);
    try {
      const res = await fetch("/api/procurement/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(true)),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to submit request"); return; }
      toast.success(`Request submitted — ${json.data.pr_number}`);
      router.push(`/procurement/requests/${json.data.id}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Purchase Request</h1>
          <p className="text-sm text-muted-foreground">Fill in details and add items to request</p>
        </div>
      </div>

      {/* Request Details */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Request Details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="department">Department <span className="text-red-500">*</span></Label>
            <Select
              value={department}
              onValueChange={(v) => setDepartment(v as ProcurementDepartment)}
            >
              <SelectTrigger id="department">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROCUREMENT_DEPARTMENTS.map((d) => (
                  <SelectItem key={d} value={d}>{PROCUREMENT_DEPARTMENT_LABELS[d]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="location">Location</Label>
            <Select value={locationId || "__none__"} onValueChange={(v) => setLocationId(v === "__none__" ? "" : v)}>
              <SelectTrigger id="location">
                <SelectValue placeholder="Select location (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No specific location</SelectItem>
                {locations.map((loc) => (
                  <SelectItem key={loc.id} value={loc.id}>{loc.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              placeholder="Any additional context for this request..."
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
            onClick={() => {
              const newItem = emptyItem();
              setItems((prev) => [...prev, newItem]);
              setTimeout(() => openCatalogForItem(newItem.id), 0);
            }}
          >
            <Plus className="h-4 w-4 mr-1" /> Add Item
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.map((li, idx) => (
            <div key={li.id} className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Item {idx + 1}</span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openCatalogForItem(li.id)}
                  >
                    <Package className="h-3.5 w-3.5 mr-1" />
                    {li.item_id ? "Change Item" : "Select from Catalog"}
                  </Button>
                  {items.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => removeItem(li.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>

              {li.item_id && (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="bg-blue-50 text-blue-700 text-xs">
                    From catalog
                  </Badge>
                  <ItemHistoryDialog itemId={li.item_id} itemName={li.item_name} />
                </div>
              )}

              {!li.item_id && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                  Please select an item from the catalog using the button above.
                </p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Item Name <span className="text-red-500">*</span></Label>
                  <Input
                    placeholder="Select from catalog to set item name"
                    value={li.item_name}
                    readOnly={true}
                    className="bg-muted/50"
                  />
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
                    <Select
                      value={li.unit}
                      onValueChange={(v) => updateItem(li.id, "unit", v)}
                      disabled={!!li.item_id}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ITEM_UNITS.map((u) => (
                          <SelectItem key={u} value={u}>{u}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs">Est. Price per Unit (₹)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={li.estimated_price}
                    onChange={(e) => updateItem(li.id, "estimated_price", e.target.value)}
                  />
                </div>

                {li.estimated_price && li.quantity && (
                  <div className="flex items-end pb-0.5">
                    <p className="text-sm text-muted-foreground">
                      Line total:{" "}
                      <span className="font-medium text-foreground">
                        {formatCurrency(parseFloat(li.quantity || "0") * parseFloat(li.estimated_price || "0"))}
                      </span>
                    </p>
                  </div>
                )}

                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">Notes (optional)</Label>
                  <Input
                    placeholder="Brand preference, urgency, etc."
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
            <p className="text-sm text-muted-foreground">Total Estimated</p>
            <p className="text-xl font-bold">
              {totalEstimated > 0 ? formatCurrency(totalEstimated) : "—"}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleSaveDraft}
              disabled={savingDraft || submitting}
            >
              {savingDraft ? "Saving..." : "Save as Draft"}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || savingDraft}
            >
              {submitting ? "Submitting..." : "Submit for Approval"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Catalog Picker Dialog */}
      <Dialog
        open={catalogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setItems((prev) => {
              const target = prev.find((li) => li.id === targetItemId);
              if (target && !target.item_id && !target.item_name.trim() && prev.length > 1) {
                return prev.filter((li) => li.id !== targetItemId);
              }
              return prev;
            });
            setCatalogOpen(false);
          }
        }}
      >
        <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Select from Catalog — {PROCUREMENT_DEPARTMENT_LABELS[department]}</DialogTitle>
          </DialogHeader>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search items..."
              className="pl-9"
              value={catalogSearch}
              onChange={(e) => setCatalogSearch(e.target.value)}
            />
          </div>
          <div className="overflow-y-auto flex-1 space-y-1 mt-2">
            {catalogLoading ? (
              <p className="text-sm text-muted-foreground text-center py-8">Loading...</p>
            ) : catalogItems.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No items found in catalog for {PROCUREMENT_DEPARTMENT_LABELS[department]}</p>
            ) : (
              catalogItems.map((item) => (
                <button
                  key={item.id}
                  className="w-full text-left px-3 py-2.5 rounded-md hover:bg-muted/60 transition-colors border border-transparent hover:border-border"
                  onClick={() => selectCatalogItem(item)}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{item.name}</span>
                    <span className="text-xs text-muted-foreground">{item.unit}</span>
                  </div>
                  {item.standard_price && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Std. price: {formatCurrency(item.standard_price)}
                    </p>
                  )}
                  {item.description && (
                    <p className="text-xs text-muted-foreground/80 mt-0.5 italic">{item.description}</p>
                  )}
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
