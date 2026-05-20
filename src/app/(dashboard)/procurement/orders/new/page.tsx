"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Trash2, ChevronLeft, Loader2, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { ITEM_UNITS, PO_ADVANCE_PAYMENT_MODE_LABELS, GST_RATES, GST_RATE_LABELS } from "@/lib/constants";
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
  gst_rate: string;
  notes: string;
  // Ceiling info from PR (display only — not sent in API)
  approved_qty?: number;
  already_ordered_qty?: number;
  remaining_qty?: number;
  estimated_price?: number;
  fully_ordered?: boolean;
}

const today = new Date().toISOString().split("T")[0];

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
  gst_rate: "0",
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

  // ── Show redirect screen when no pr_id is provided ──────────────────────────
  if (!prId) {
    return (
      <div className="space-y-6 max-w-2xl mx-auto">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.back()}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-2xl font-bold">New Purchase Order</h1>
        </div>
        <Card className="border-amber-200 bg-amber-50/50">
          <CardContent className="pt-6 flex gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-amber-800">Material Request Required</p>
              <p className="text-sm text-amber-700 mt-1">
                Purchase Orders can only be created from an approved Material Request. Please select an
                approved request first, then use the &ldquo;Create PO&rdquo; button.
              </p>
              <Button
                size="sm"
                className="mt-3 bg-amber-700 hover:bg-amber-800"
                onClick={() => router.push("/procurement/requests?status=approved")}
              >
                Browse Approved Requests
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <NewPurchaseOrderFormWithPr prId={prId} vendors={vendors} setVendors={setVendors}
    locations={locations} setLocations={setLocations} prData={prData} setPrData={setPrData}
    loadingPr={loadingPr} setLoadingPr={setLoadingPr} vendorId={vendorId} setVendorId={setVendorId}
    locationId={locationId} setLocationId={setLocationId} expectedDeliveryDate={expectedDeliveryDate}
    setExpectedDeliveryDate={setExpectedDeliveryDate} notes={notes} setNotes={setNotes}
    items={items} setItems={setItems} submitting={submitting} setSubmitting={setSubmitting}
    router={router} />;
}

// Separate component to keep hooks after early return
function NewPurchaseOrderFormWithPr({
  prId, vendors, setVendors, locations, setLocations,
  prData, setPrData, loadingPr, setLoadingPr,
  vendorId, setVendorId, locationId, setLocationId,
  expectedDeliveryDate, setExpectedDeliveryDate,
  notes, setNotes, items, setItems, submitting, setSubmitting,
  router,
}: {
  prId: string;
  vendors: ProcurementVendor[]; setVendors: (v: ProcurementVendor[]) => void;
  locations: Location[]; setLocations: (l: Location[]) => void;
  prData: PurchaseRequest | null; setPrData: (p: PurchaseRequest | null) => void;
  loadingPr: boolean; setLoadingPr: (v: boolean) => void;
  vendorId: string; setVendorId: (v: string) => void;
  locationId: string; setLocationId: (v: string) => void;
  expectedDeliveryDate: string; setExpectedDeliveryDate: (v: string) => void;
  notes: string; setNotes: (v: string) => void;
  items: LineItem[]; setItems: (v: LineItem[]) => void;
  submitting: boolean; setSubmitting: (v: boolean) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  router: any;
}) {
  // Fetch vendors and locations on mount
  useEffect(() => {
    Promise.all([
      fetch("/api/procurement/vendors").then((r) => r.json()),
      fetch("/api/locations").then((r) => r.json()),
    ]).then(([v, l]) => {
      setVendors(v.data || []);
      setLocations(l.data || []);
    });
  }, [setVendors, setLocations]);

  // Pre-populate from PR
  useEffect(() => {
    setLoadingPr(true);
    fetch(`/api/procurement/requests/${prId}`)
      .then((r) => r.json())
      .then((json) => {
        const pr = json.data;
        if (!pr) return;
        setPrData(pr);
        setLocationId(pr.location_id ?? "");
        // Carry forward PR-level notes to PO
        if (pr.notes) setNotes(pr.notes);
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
              already_ordered_qty?: number;
              remaining_qty?: number;
              procurement_items?: { gst_rate?: number } | null;
            }) => {
              const remainingQty = i.remaining_qty ?? i.quantity;
              const fullyOrdered = remainingQty <= 0;
              return {
                id: generateLocalId(),
                pr_item_id: i.id,
                item_id: i.item_id ?? null,
                item_name: i.item_name,
                quantity_ordered: fullyOrdered ? "0" : String(Math.min(i.quantity, remainingQty)),
                unit: i.unit,
                unit_price: i.estimated_price ? String(i.estimated_price) : "",
                gst_rate: String(i.procurement_items?.gst_rate ?? 0),
                notes: i.notes ?? "",
                approved_qty: i.quantity,
                already_ordered_qty: i.already_ordered_qty ?? 0,
                remaining_qty: remainingQty,
                estimated_price: i.estimated_price ?? undefined,
                fully_ordered: fullyOrdered,
              };
            })
          );
        }
      })
      .finally(() => setLoadingPr(false));
  }, [prId, setPrData, setLocationId, setItems, setLoadingPr]);

  const [paymentTerms, setPaymentTerms] = useState("");
  const [termsAndConditions, setTermsAndConditions] = useState("");

  // Vendor price memory: item_id → { price, gst_rate }
  const [vendorPriceMap, setVendorPriceMap] = useState<Map<string, { price: number; gst_rate: number }>>(new Map());

  // Advance payment
  const [advanceRequired, setAdvanceRequired] = useState(false);
  const [advanceExpanded, setAdvanceExpanded] = useState(false);
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [advanceMode, setAdvanceMode] = useState("");
  const [advanceReference, setAdvanceReference] = useState("");
  const [advanceNotes, setAdvanceNotes] = useState("");

  // Blank-price warning dialog
  const [showPriceWarning, setShowPriceWarning] = useState(false);
  const [missingPriceItems, setMissingPriceItems] = useState<string[]>([]);

  const handleVendorChange = async (newVendorId: string) => {
    const actualId = newVendorId === "__none__" ? "" : newVendorId;
    setVendorId(actualId);

    if (actualId) {
      const vendor = vendors.find((v) => v.id === actualId);
      if (vendor) {
        setPaymentTerms(vendor.payment_terms ?? "");
        setTermsAndConditions(vendor.terms_and_conditions ?? "");
      }

      // Fetch this vendor's known prices and auto-fill unit_price fields
      try {
        const res = await fetch(`/api/procurement/vendor-prices?vendor_id=${actualId}`);
        if (res.ok) {
          const { data } = await res.json();
          const map = new Map<string, { price: number; gst_rate: number }>(
            (data ?? [])
              .filter((r: { item_id?: string }) => r.item_id)
              .map((r: { item_id: string; price: number; gst_rate: number }) => [
                r.item_id,
                { price: r.price, gst_rate: r.gst_rate },
              ])
          );
          setVendorPriceMap(map);

          // Apply to current line items that have a catalog item_id
          setItems(
            items.map((li: LineItem) => {
              if (!li.item_id || !map.has(li.item_id)) return li;
              const known = map.get(li.item_id)!;
              return {
                ...li,
                unit_price: String(known.price),
                gst_rate:   String(known.gst_rate),
              };
            })
          );
        }
      } catch {
        // Non-critical — user can still enter prices manually
      }
    } else {
      setVendorPriceMap(new Map());
      setPaymentTerms("");
      setTermsAndConditions("");
    }
  };

  const updateItem = (localId: string, field: keyof LineItem, value: string) => {
    setItems(
      items.map((li) => (li.id === localId ? { ...li, [field]: value } : li))
    );
  };

  const removeItem = (localId: string) => {
    if (items.filter(li => !li.fully_ordered).length <= 1) {
      toast.error("At least one item is required");
      return;
    }
    setItems(items.filter((li) => li.id !== localId));
  };

  const activeItems = items.filter((li) => !li.fully_ordered);

  const totalOrdered = activeItems.reduce((sum, li) => {
    const q = parseFloat(li.quantity_ordered);
    const p = parseFloat(li.unit_price);
    if (!isNaN(q) && !isNaN(p)) return sum + q * p;
    return sum;
  }, 0);

  const totalGst = activeItems.reduce((sum, li) => {
    const q = parseFloat(li.quantity_ordered);
    const p = parseFloat(li.unit_price);
    const g = parseFloat(li.gst_rate) || 0;
    if (!isNaN(q) && !isNaN(p)) return sum + Math.round(q * p * g) / 100;
    return sum;
  }, 0);

  const validate = (): string | null => {
    if (!vendorId) return "Please select a vendor";
    if (advanceRequired) {
      if (!advanceAmount || isNaN(parseFloat(advanceAmount)) || parseFloat(advanceAmount) <= 0)
        return "Advance amount must be a positive number";
      if (!advanceMode) return "Please select a payment mode for the advance";
      const poTotal = totalOrdered + totalGst;
      if (poTotal > 0 && parseFloat(advanceAmount) > poTotal) {
        return `Advance amount (₹${parseFloat(advanceAmount).toLocaleString("en-IN")}) cannot exceed PO total (₹${poTotal.toLocaleString("en-IN")})`;
      }
    }
    if (expectedDeliveryDate && expectedDeliveryDate < today) {
      return "Expected delivery date cannot be in the past. Please select today or a future date.";
    }
    const orderable = activeItems.filter(li => parseFloat(li.quantity_ordered) > 0);
    if (orderable.length === 0) return "At least one item must have a quantity greater than 0";
    for (const li of orderable) {
      if (!li.item_name.trim()) return "All items must have a name";
      if (!li.quantity_ordered || isNaN(parseFloat(li.quantity_ordered)) || parseFloat(li.quantity_ordered) <= 0) {
        return "All items must have a valid quantity";
      }
      // Client-side ceiling checks
      if (li.remaining_qty !== undefined) {
        const qty = parseFloat(li.quantity_ordered);
        if (qty > li.remaining_qty) {
          return `"${li.item_name}": quantity (${qty}) exceeds remaining approved quantity (${li.remaining_qty})`;
        }
      }
      if (li.estimated_price && li.unit_price) {
        const price = parseFloat(li.unit_price);
        if (!isNaN(price) && price > li.estimated_price) {
          return `"${li.item_name}": unit price exceeds approved estimated price (₹${li.estimated_price})`;
        }
      }
    }
    return null;
  };

  // Separated so the warning dialog's "Proceed anyway" button can call it directly.
  const doSubmit = async () => {
    setSubmitting(true);
    try {
      // Only send items that have a positive quantity and are not fully ordered
      const orderable = activeItems.filter(li => parseFloat(li.quantity_ordered) > 0);
      const payload = {
        pr_id: prId,
        vendor_id: vendorId,
        location_id: locationId || null,
        expected_delivery_date: expectedDeliveryDate || null,
        notes: notes.trim() || null,
        payment_terms: paymentTerms.trim() || null,
        terms_and_conditions: termsAndConditions.trim() || null,
        advance_amount: advanceRequired && advanceAmount ? parseFloat(advanceAmount) : null,
        advance_payment_mode: advanceRequired && advanceMode ? advanceMode : null,
        advance_payment_reference: advanceRequired && advanceReference.trim() ? advanceReference.trim() : null,
        advance_notes: advanceRequired && advanceNotes.trim() ? advanceNotes.trim() : null,
        items: orderable.map((li) => ({
          pr_item_id: li.pr_item_id ?? null,
          item_id: li.item_id ?? null,
          item_name: li.item_name.trim(),
          quantity_ordered: parseFloat(li.quantity_ordered),
          unit: li.unit,
          unit_price: li.unit_price ? parseFloat(li.unit_price) : null,
          gst_rate: parseFloat(li.gst_rate) || 0,
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

  const handleSubmit = () => {
    const err = validate();
    if (err) { toast.error(err); return; }

    // Soft check: warn if any orderable item is missing a unit price.
    // Accounts may not be able to reconcile a PO with ₹0 line items later.
    const orderable = activeItems.filter(li => parseFloat(li.quantity_ordered) > 0);
    const noPriceItems = orderable
      .filter(li => !li.unit_price || parseFloat(li.unit_price) <= 0)
      .map(li => li.item_name);

    if (noPriceItems.length > 0) {
      setMissingPriceItems(noPriceItems);
      setShowPriceWarning(true);
      return;
    }

    doSubmit();
  };

  if (loadingPr) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const allItemsFullyOrdered = items.length > 0 && items.every((li) => li.fully_ordered);

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
          Items pre-populated from <strong>{prData.pr_number}</strong>. Quantities and prices cannot exceed approved values.
          {prData.approval_code && (
            <span className="ml-2 font-mono text-xs">Approval: {prData.approval_code}</span>
          )}
        </div>
      )}

      {/* All items fully ordered warning */}
      {allItemsFullyOrdered && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 px-4 py-3 text-sm text-amber-800 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          All items from this Material Request have already been fully ordered. No additional POs are needed.
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
            <Select value={vendorId || "__none__"} onValueChange={handleVendorChange}>
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
              min={today}
              value={expectedDeliveryDate}
              onChange={(e) => setExpectedDeliveryDate(e.target.value)}
            />
            {expectedDeliveryDate && expectedDeliveryDate < today && (
              <p className="text-xs text-red-600">Date cannot be in the past.</p>
            )}
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

          <div className="space-y-1.5">
            <Label htmlFor="payment_terms">Payment Terms</Label>
            <input
              id="payment_terms"
              type="text"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder="e.g. Net 30, Immediate (pre-filled from vendor)"
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="terms_and_conditions">Terms &amp; Conditions</Label>
            <Textarea
              id="terms_and_conditions"
              placeholder="Pre-filled from vendor profile. Edit if needed."
              value={termsAndConditions}
              onChange={(e) => setTermsAndConditions(e.target.value)}
              rows={3}
            />
          </div>
        </CardContent>
      </Card>

      {/* Advance Payment */}
      <Card>
        <CardHeader
          className="flex flex-row items-center justify-between pb-3 cursor-pointer select-none"
          onClick={() => setAdvanceExpanded((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">Advance Payment</CardTitle>
            <span className="text-xs text-muted-foreground">(optional)</span>
          </div>
          {advanceExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </CardHeader>
        {advanceExpanded && (
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2">
              <input
                id="advance_required"
                type="checkbox"
                checked={advanceRequired}
                onChange={(e) => {
                  setAdvanceRequired(e.target.checked);
                  if (!e.target.checked) {
                    setAdvanceAmount("");
                    setAdvanceMode("");
                    setAdvanceReference("");
                    setAdvanceNotes("");
                  }
                }}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="advance_required" className="cursor-pointer">Advance payment required for this order</Label>
            </div>

            {advanceRequired && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t">
                <div className="space-y-1.5">
                  <Label htmlFor="advance_amount">Advance Amount (₹) <span className="text-red-500">*</span></Label>
                  <Input
                    id="advance_amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="e.g. 5000"
                    value={advanceAmount}
                    onChange={(e) => setAdvanceAmount(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="advance_mode">Payment Mode <span className="text-red-500">*</span></Label>
                  <Select value={advanceMode || "__none__"} onValueChange={(v) => setAdvanceMode(v === "__none__" ? "" : v)}>
                    <SelectTrigger id="advance_mode">
                      <SelectValue placeholder="Select mode…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Select mode…</SelectItem>
                      {Object.entries(PO_ADVANCE_PAYMENT_MODE_LABELS).map(([k, label]) => (
                        <SelectItem key={k} value={k}>{label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="advance_reference">Reference No.</Label>
                  <Input
                    id="advance_reference"
                    placeholder="e.g. NEFT/20250318/001"
                    value={advanceReference}
                    onChange={(e) => setAdvanceReference(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="advance_notes">Notes</Label>
                  <Input
                    id="advance_notes"
                    placeholder="Any notes about this advance…"
                    value={advanceNotes}
                    onChange={(e) => setAdvanceNotes(e.target.value)}
                  />
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Line Items */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">Items <span className="text-red-500">*</span></CardTitle>
          {!prId && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setItems([...items, emptyItem()])}
            >
              <Plus className="h-4 w-4 mr-1" /> Add Item
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {items.map((li, idx) => (
            <div
              key={li.id}
              className={`border rounded-lg p-4 space-y-3 ${li.fully_ordered ? "bg-muted/40 opacity-70" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Item {idx + 1}</span>
                <div className="flex items-center gap-2">
                  {li.fully_ordered && (
                    <Badge variant="secondary" className="bg-slate-100 text-slate-600 text-xs">
                      Fully Ordered
                    </Badge>
                  )}
                  {li.pr_item_id && !li.fully_ordered && (
                    <Badge variant="secondary" className="bg-blue-50 text-blue-700 text-xs">
                      From PR
                    </Badge>
                  )}
                  {!li.pr_item_id && items.length > 1 && (
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

              {li.fully_ordered ? (
                // Fully ordered — show read-only summary
                <p className="text-xs text-muted-foreground">
                  {li.item_name} — Approved: {li.approved_qty} {li.unit} · Already ordered: {li.already_ordered_qty} {li.unit} · Remaining: 0
                </p>
              ) : (
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
                        max={li.remaining_qty !== undefined ? li.remaining_qty : undefined}
                        onChange={(e) => updateItem(li.id, "quantity_ordered", e.target.value)}
                      />
                      {li.pr_item_id && li.remaining_qty !== undefined && (
                        <p className="text-xs text-muted-foreground">
                          Approved: {li.approved_qty}{" "}
                          {li.already_ordered_qty ? `· Ordered: ${li.already_ordered_qty} · ` : "· "}
                          <span className={parseFloat(li.quantity_ordered) > (li.remaining_qty ?? Infinity) ? "text-red-600 font-medium" : ""}>
                            Remaining: {li.remaining_qty}
                          </span>
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Unit</Label>
                      <Select
                        value={li.unit}
                        onValueChange={(v) => updateItem(li.id, "unit", v)}
                        disabled={!!li.pr_item_id}
                      >
                        <SelectTrigger className={`h-9 ${li.pr_item_id ? "bg-muted/50" : ""}`}>
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
                      max={li.estimated_price !== undefined ? li.estimated_price : undefined}
                      onChange={(e) => updateItem(li.id, "unit_price", e.target.value)}
                    />
                    {li.estimated_price !== undefined && (
                      <p className={`text-xs ${li.unit_price && parseFloat(li.unit_price) > li.estimated_price ? "text-red-600 font-medium" : "text-muted-foreground"}`}>
                        Max approved: ₹{li.estimated_price}
                      </p>
                    )}
                    {li.item_id && vendorPriceMap.has(li.item_id) && (
                      <p className="text-xs text-blue-600">
                        ↑ From last PO with this vendor
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">GST %</Label>
                    <Select value={li.gst_rate} onValueChange={(v) => updateItem(li.id, "gst_rate", v)}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {GST_RATES.map((r) => (
                          <SelectItem key={r} value={String(r)}>{GST_RATE_LABELS[r]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {li.unit_price && li.quantity_ordered && (
                    <div className="flex items-end pb-0.5">
                      <p className="text-sm text-muted-foreground">
                        Line total:{" "}
                        <span className="font-medium text-foreground">
                          {(() => {
                            const base = parseFloat(li.quantity_ordered || "0") * parseFloat(li.unit_price || "0");
                            const gst = Math.round(base * (parseFloat(li.gst_rate) || 0)) / 100;
                            return formatCurrency(base + gst);
                          })()}
                        </span>
                        {parseFloat(li.gst_rate) > 0 && (
                          <span className="text-xs ml-1">
                            (incl. GST {formatCurrency(Math.round(parseFloat(li.quantity_ordered || "0") * parseFloat(li.unit_price || "0") * (parseFloat(li.gst_rate) || 0)) / 100)})
                          </span>
                        )}
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
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Summary & Actions */}
      <Card>
        <CardContent className="pt-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Subtotal</p>
            <p className="text-lg font-semibold">
              {totalOrdered > 0 ? formatCurrency(totalOrdered) : "—"}
            </p>
            {totalGst > 0 && (
              <p className="text-sm text-muted-foreground mt-0.5">
                GST: <span className="font-medium text-foreground">{formatCurrency(totalGst)}</span>
              </p>
            )}
            <p className="text-xl font-bold mt-1">
              Total: {totalOrdered > 0 ? formatCurrency(totalOrdered + totalGst) : "—"}
            </p>
          </div>
          <Button onClick={handleSubmit} disabled={submitting || allItemsFullyOrdered} size="lg">
            {submitting ? (
              <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Creating…</>
            ) : allItemsFullyOrdered ? (
              "All Items Already Ordered"
            ) : (
              "Create Purchase Order"
            )}
          </Button>
        </CardContent>
      </Card>

      {/* ── Blank-price warning dialog ───────────────────────────────────── */}
      <Dialog open={showPriceWarning} onOpenChange={setShowPriceWarning}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-5 w-5 flex-shrink-0" />
              Items without a price
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              The following item{missingPriceItems.length !== 1 ? "s have" : " has"} no unit price entered.
              The PO will be created with ₹0 for {missingPriceItems.length !== 1 ? "these lines" : "this line"},
              which means the PO total will be incorrect and accounts won&apos;t be able to match it to a bill.
            </p>
            <ul className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 space-y-1">
              {missingPriceItems.map((name) => (
                <li key={name} className="text-amber-800 font-medium text-xs">• {name}</li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              Go back and enter prices, or proceed if you&apos;ll update them later (not recommended).
            </p>
          </div>
          <DialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => setShowPriceWarning(false)}
            >
              Go back and fill prices
            </Button>
            <Button
              variant="destructive"
              disabled={submitting}
              onClick={() => {
                setShowPriceWarning(false);
                doSubmit();
              }}
            >
              {submitting ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Creating…</> : "Proceed without prices"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
