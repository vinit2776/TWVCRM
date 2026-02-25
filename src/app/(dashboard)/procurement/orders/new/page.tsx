"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Trash2, ChevronLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ITEM_UNITS } from "@/lib/constants";
import { formatCurrency } from "@/lib/utils";
import type { ProcurementVendor, Location, PurchaseRequest, ItemUnit } from "@/types";

interface LineItem {
  id: string;
  pr_item_id: string | null;
  item_id: string | null;
  item_name: string;
  quantity_ordered: string;
  unit: ItemUnit;
  unit_price: string;
  notes: string;
}

function generateLocalId() {
  return Math.random().toString(36).slice(2);
}

const emptyItem = (): LineItem => ({
  id: generateLocalId(),
  pr_item_id: null,
  item_id: null,
  item_name: "",
  quantity_ordered: "",
  unit: "piece",
  unit_price: "",
  notes: "",
});

function NewPurchaseOrderForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const prId = searchParams.get("pr_id");

  const [vendorId, setVendorId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([emptyItem()]);
  const [submitting, setSubmitting] = useState(false);

  const [vendors, setVendors] = useState<ProcurementVendor[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [prData, setPrData] = useState<PurchaseRequest | null>(null);
  const [loadingPr, setLoadingPr] = useState(false);

  // Fetch vendors and locations on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/procurement/vendors").then((r) => r.json()),
      fetch("/api/locations").then((r) => r.json()),
    ]).then(([v, l]) => {
      setVendors(v.data || []);
      setLocations(l.data || []);
    });
  }, []);

  // Pre-populate from PR if pr_id given
  useEffect(() => {
    if (!prId) return;
    setLoadingPr(true);
    fetch(`/api/procurement/requests/${prId}`)
      .then((r) => r.json())
      .then((json) => {
        const pr = json.data;
        if (!pr) return;
        setPrData(pr);
        setLocationId(pr.location_id ?? "");
        if (pr.purchase_request_items?.length) {
          setItems(
            pr.purchase_request_items.map((i: {
              id: string;
              item_id?: string | null;
              item_name: string;
              quantity: number;
              unit: ItemUnit;
              estimated_price?: number | null;
              notes?: string | null;
            }) => ({
              id: generateLocalId(),
              pr_item_id: i.id,
              item_id: i.item_id ?? null,
              item_name: i.item_name,
              quantity_ordered: String(i.quantity),
              unit: i.unit,
              unit_price: i.estimated_price ? String(i.estimated_price) : "",
              notes: i.notes ?? "",
            }))
          );
        }
      })
      .finally(() => setLoadingPr(false));
  }, [prId]);

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

  const totalOrdered = items.reduce((sum, li) => {
    const q = parseFloat(li.quantity_ordered);
    const p = parseFloat(li.unit_price);
    if (!isNaN(q) && !isNaN(p)) return sum + q * p;
    return sum;
  }, 0);

  const validate = (): string | null => {
    if (!vendorId) return "Please select a vendor";
    for (const li of items) {
      if (!li.item_name.trim()) return "All items must have a name";
      if (!li.quantity_ordered || isNaN(parseFloat(li.quantity_ordered)) || parseFloat(li.quantity_ordered) <= 0) {
        return "All items must have a valid quantity";
      }
    }
    return null;
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }

    setSubmitting(true);
    try {
      const payload = {
        pr_id: prId ?? null,
        vendor_id: vendorId,
        location_id: locationId || null,
        expected_delivery_date: expectedDeliveryDate || null,
        notes: notes.trim() || null,
        items: items.map((li) => ({
          pr_item_id: li.pr_item_id ?? null,
          item_id: li.item_id ?? null,
          item_name: li.item_name.trim(),
          quantity_ordered: parseFloat(li.quantity_ordered),
          unit: li.unit,
          unit_price: li.unit_price ? parseFloat(li.unit_price) : null,
          notes: li.notes.trim() || null,
        })),
      };

      const res = await fetch("/api/procurement/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(typeof json.error === "string" ? json.error : "Failed to create purchase order");
        return;
      }
      toast.success(`Purchase order created — ${json.data.po_number}`);
      router.push(`/procurement/orders/${json.data.id}`);
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingPr) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Purchase Order</h1>
          <p className="text-sm text-muted-foreground">
            {prData ? `Creating PO for ${prData.pr_number}` : "Create a purchase order for your vendor"}
          </p>
        </div>
      </div>

      {/* PR context banner */}
      {prData && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/50 px-4 py-3 text-sm text-blue-800">
          Items pre-populated from <strong>{prData.pr_number}</strong>. You can adjust quantities and add unit prices.
        </div>
      )}

      {/* Order Details */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order Details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="vendor">Vendor <span className="text-red-500">*</span></Label>
            <Select value={vendorId || "__none__"} onValueChange={(v) => setVendorId(v === "__none__" ? "" : v)}>
              <SelectTrigger id="vendor">
                <SelectValue placeholder="Select vendor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Select a vendor…</SelectItem>
                {vendors.map((v) => (
                  <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="location">Delivery Location</Label>
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

          <div className="space-y-1.5">
            <Label htmlFor="expected_delivery">Expected Delivery Date</Label>
            <Input
              id="expected_delivery"
              type="date"
              value={expectedDeliveryDate}
              onChange={(e) => setExpectedDeliveryDate(e.target.value)}
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              placeholder="Any additional notes for this order..."
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
            onClick={() => setItems((prev) => [...prev, emptyItem()])}
          >
            <Plus className="h-4 w-4 mr-1" /> Add Item
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.map((li, idx) => (
            <div key={li.id} className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Item {idx + 1}</span>
                <div className="flex items-center gap-2">
                  {li.pr_item_id && (
                    <Badge variant="secondary" className="bg-blue-50 text-blue-700 text-xs">
                      From PR
                    </Badge>
                  )}
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Item Name <span className="text-red-500">*</span></Label>
                  <Input
                    placeholder="e.g. Premium Coffee Beans"
                    value={li.item_name}
                    onChange={(e) => updateItem(li.id, "item_name", e.target.value)}
                    readOnly={!!li.pr_item_id}
                    className={li.pr_item_id ? "bg-muted/50" : ""}
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Qty Ordered <span className="text-red-500">*</span></Label>
                    <Input
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="0"
                      value={li.quantity_ordered}
                      onChange={(e) => updateItem(li.id, "quantity_ordered", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Unit</Label>
                    <Select
                      value={li.unit}
                      onValueChange={(v) => updateItem(li.id, "unit", v)}
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
                  <Label className="text-xs">Unit Price (₹)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00 (optional)"
                    value={li.unit_price}
                    onChange={(e) => updateItem(li.id, "unit_price", e.target.value)}
                  />
                </div>

                {li.unit_price && li.quantity_ordered && (
                  <div className="flex items-end pb-0.5">
                    <p className="text-sm text-muted-foreground">
                      Line total:{" "}
                      <span className="font-medium text-foreground">
                        {formatCurrency(parseFloat(li.quantity_ordered || "0") * parseFloat(li.unit_price || "0"))}
                      </span>
                    </p>
                  </div>
                )}

                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">Notes (optional)</Label>
                  <Input
                    placeholder="Special instructions, delivery notes..."
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
            <p className="text-sm text-muted-foreground">Total Ordered Amount</p>
            <p className="text-xl font-bold">
              {totalOrdered > 0 ? formatCurrency(totalOrdered) : "—"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              (Only items with unit price contribute to total)
            </p>
          </div>
          <Button onClick={handleSubmit} disabled={submitting} size="lg">
            {submitting ? (
              <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Creating…</>
            ) : (
              "Create Purchase Order"
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function NewPurchaseOrderPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <NewPurchaseOrderForm />
    </Suspense>
  );
}
