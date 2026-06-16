"use client";

import { useState, useEffect } from "react";
import { useCurrentUser } from "@/providers/current-user-provider";
import { useRouter } from "next/navigation";
import { Plus, Trash2, ChevronLeft, Search, Package, PenLine, AlertTriangle, FileUp, Paperclip } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
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
  catalog_standard_price: number | null; // price ceiling — cannot exceed this (catalog items only)
  notes: string;
  isCustom: boolean;       // true = free-text item, not from catalog
  suggestCatalog: boolean; // true = POST to catalog as draft after PR submission
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
  catalog_standard_price: null,
  notes: "",
  isCustom: false,
  suggestCatalog: false,
});

export default function NewPurchaseRequestPage() {
  const router = useRouter();
  const { user } = useCurrentUser();
  const [department, setDepartment] = useState<ProcurementDepartment>("pantry");
  const [locationId, setLocationId] = useState<string>("");
  const [amcBudgetCheck, setAmcBudgetCheck] = useState<{
    has_budget: boolean;
    annual_budget: number | null;
    committed_so_far: number;
    provisional_in_pipeline: number;
    financial_year: number;
  } | null>(null);

  // expenditure_type is derived automatically from department:
  // department="amc" → expenditure_type="amc"; everything else → "operational"
  const expenditureType = department === "amc" ? "amc" : "operational";

  const handleDepartmentChange = (v: ProcurementDepartment) => {
    setDepartment(v);
  };

  // Fetch AMC annual budget preview whenever AMC department is selected
  useEffect(() => {
    if (department !== "amc") { setAmcBudgetCheck(null); return; }
    fetch("/api/procurement/budget/check?department=amc&expenditure_type=amc&amount=0")
      .then((r) => r.json())
      .then((j) => setAmcBudgetCheck(j))
      .catch(() => setAmcBudgetCheck(null));
  }, [department]);
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([emptyItem()]);
  // Quotations: staged in client memory until the MR is created, then uploaded.
  const [quotations, setQuotations] = useState<Array<{
    id: string;
    vendor_name: string;
    amount: string;
    notes: string;
    file: File | null;
  }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [showPriceWarning, setShowPriceWarning] = useState(false);
  const [missingPriceItems, setMissingPriceItems] = useState<string[]>([]);
  // Pre-GST confirm gate — appears on submit when any item has a price entered.
  // Acks (per session) that the user has read it; after first confirm, suppress for repeat submits.
  const [showPreGstConfirm, setShowPreGstConfirm] = useState(false);
  const [preGstAcked, setPreGstAcked] = useState(false);
  const userRole = user?.role ?? "";
  const canSeePrices = ["admin", "manager"].includes(userRole);

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
    const stdPrice = catalogItem.standard_price != null ? Number(catalogItem.standard_price) : null;
    setItems((prev) =>
      prev.map((li) =>
        li.id === targetItemId
          ? {
              ...li,
              item_id: catalogItem.id,
              item_name: catalogItem.name,
              unit: catalogItem.unit,
              catalog_standard_price: stdPrice,
              isCustom: false,
              suggestCatalog: false,
              // Pre-fill price only if current entry is blank or higher than catalog ceiling
              estimated_price: stdPrice != null
                ? String(stdPrice)
                : li.estimated_price,
            }
          : li
      )
    );
    setCatalogOpen(false);
  };

  const updateItem = (localId: string, field: keyof LineItem, value: string | boolean) => {
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
    expenditure_type: expenditureType,
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

  const isPriceOverCeiling = (li: LineItem): boolean => {
    if (li.isCustom) return false; // no ceiling for custom items
    if (li.catalog_standard_price == null || !li.estimated_price) return false;
    return parseFloat(li.estimated_price) > li.catalog_standard_price;
  };

  const validQuotations = quotations.filter(
    (q) => q.file && q.vendor_name.trim() && q.amount && !isNaN(parseFloat(q.amount))
  );

  const addQuotation = () => {
    setQuotations((prev) => [
      ...prev,
      { id: generateLocalId(), vendor_name: "", amount: "", notes: "", file: null },
    ]);
  };

  const updateQuotation = (
    localId: string,
    field: "vendor_name" | "amount" | "notes",
    value: string,
  ) => {
    setQuotations((prev) =>
      prev.map((q) => (q.id === localId ? { ...q, [field]: value } : q))
    );
  };

  const setQuotationFile = (localId: string, file: File | null) => {
    if (file && file.size > 50 * 1024 * 1024) {
      toast.error("File too large (max 50 MB)");
      return;
    }
    setQuotations((prev) =>
      prev.map((q) => (q.id === localId ? { ...q, file } : q))
    );
  };

  const removeQuotation = (localId: string) => {
    setQuotations((prev) => prev.filter((q) => q.id !== localId));
  };

  // Upload each staged quotation against the freshly-created MR.
  // Returns the number that succeeded.
  const uploadQuotationsFor = async (prId: string): Promise<number> => {
    let ok = 0;
    for (const q of validQuotations) {
      if (!q.file) continue;
      const fd = new FormData();
      fd.append("file", q.file);
      fd.append("vendor_name", q.vendor_name.trim());
      fd.append("amount", q.amount);
      if (q.notes.trim()) fd.append("notes", q.notes.trim());
      try {
        const res = await fetch(`/api/procurement/requests/${prId}/quotations`, {
          method: "POST",
          body: fd,
        });
        if (res.ok) ok++;
        else {
          const j = await res.json().catch(() => ({}));
          toast.error(`Failed to upload quotation from ${q.vendor_name}: ${j.error ?? res.statusText}`);
        }
      } catch (err) {
        toast.error(`Failed to upload quotation from ${q.vendor_name}`);
        console.error(err);
      }
    }
    return ok;
  };

  const validate = (): string | null => {
    for (const li of items) {
      if (!li.isCustom && !li.item_id) return "Please select all catalog items from the catalog, or use the Custom Item option for unlisted items";
      if (li.isCustom && !li.item_name.trim()) return "Custom items must have a name";
      if (!li.item_name.trim()) return "All items must have a name";
      if (!li.quantity || isNaN(parseFloat(li.quantity)) || parseFloat(li.quantity) <= 0)
        return "All items must have a valid quantity";
      if (isPriceOverCeiling(li))
        return `Price for "${li.item_name}" cannot exceed the catalog price of ${formatCurrency(li.catalog_standard_price!)}`;
    }
    return null;
  };

  // Submit catalog suggestions fire-and-forget after PR is created
  const submitCatalogSuggestions = (submittedItems: LineItem[]) => {
    const suggestions = submittedItems.filter((li) => li.isCustom && li.suggestCatalog && li.item_name.trim());
    if (suggestions.length === 0) return;
    Promise.allSettled(
      suggestions.map((li) =>
        fetch("/api/procurement/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: li.item_name.trim(),
            department,
            unit: li.unit,
            standard_price: li.estimated_price ? parseFloat(li.estimated_price) : undefined,
            is_active: false,
            is_suggested: true,
          }),
        })
      )
    ).then(() => {
      toast.info(`${suggestions.length} item${suggestions.length > 1 ? "s" : ""} suggested for the catalog — admin will review`);
    });
  };

  const handleSaveDraft = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    if (validQuotations.length < 1) {
      toast.error("At least one vendor quotation / estimate must be attached before saving");
      return;
    }
    setSavingDraft(true);
    try {
      // Always create as draft first so we can attach quotations against the new id.
      const res = await fetch("/api/procurement/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(false)),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to save draft"); return; }
      if (validQuotations.length > 0) {
        await uploadQuotationsFor(json.data.id);
      }
      toast.success(`Draft saved — ${json.data.pr_number}`);
      submitCatalogSuggestions(items);
      router.push(`/procurement/requests/${json.data.id}`);
    } finally {
      setSavingDraft(false);
    }
  };

  const doSubmit = async () => {
    if (validQuotations.length < 1) {
      toast.error("At least one quotation / estimate must be attached before submitting");
      return;
    }
    setSubmitting(true);
    try {
      // 1. Create the MR as draft so we have an id to attach quotations to.
      const res = await fetch("/api/procurement/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(false)),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to create request"); return; }
      const prId: string = json.data.id;

      // 2. Upload quotations.
      const uploaded = await uploadQuotationsFor(prId);
      if (uploaded < 1) {
        toast.error(
          "Could not upload any quotations — MR saved as draft. Open it and upload supporting files before submitting."
        );
        submitCatalogSuggestions(items);
        router.push(`/procurement/requests/${prId}`);
        return;
      }

      // 3. Now flip status → submitted.
      const submitRes = await fetch(`/api/procurement/requests/${prId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit" }),
      });
      const submitJson = await submitRes.json();
      if (!submitRes.ok) {
        toast.error(
          `Quotations attached but submission failed: ${submitJson.error ?? submitRes.statusText}. Open the MR and submit manually.`
        );
        submitCatalogSuggestions(items);
        router.push(`/procurement/requests/${prId}`);
        return;
      }

      toast.success(`Request submitted — ${json.data.pr_number}`);
      submitCatalogSuggestions(items);
      router.push(`/procurement/requests/${prId}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    // Warn if any item is missing an estimated price — the omission cascades
    // silently through approval → PO → vendor bill with no price on record.
    const noPriceItems = items
      .filter((li) => !li.estimated_price || parseFloat(li.estimated_price) <= 0)
      .map((li) => li.item_name || "Unnamed item");
    if (noPriceItems.length > 0) {
      setMissingPriceItems(noPriceItems);
      setShowPriceWarning(true);
      return;
    }
    // Pre-GST gate: if any item has a price entered, confirm it's pre-GST. Common mistake.
    const hasPricedItems = items.some((li) => li.estimated_price && parseFloat(li.estimated_price) > 0);
    if (hasPricedItems && !preGstAcked) {
      setShowPreGstConfirm(true);
      return;
    }
    doSubmit();
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">New Material Request</h1>
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
              onValueChange={(v) => handleDepartmentChange(v as ProcurementDepartment)}
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

          {/* AMC annual budget preview — shown when AMC department is selected */}
          {department === "amc" && amcBudgetCheck && (
            <div className="sm:col-span-2 rounded-lg border bg-purple-50 border-purple-200 px-3 py-2.5 space-y-1">
              {amcBudgetCheck.has_budget ? (
                <>
                  <p className="text-xs font-semibold text-purple-800">
                    AMC Annual Budget · FY {amcBudgetCheck.financial_year}-{String(amcBudgetCheck.financial_year + 1).slice(-2)}
                  </p>
                  <div className="flex flex-wrap gap-3 text-xs text-purple-700">
                    <span>Budget: <span className="font-semibold">{formatCurrency(amcBudgetCheck.annual_budget ?? 0)}</span></span>
                    <span>Committed: <span className="font-semibold">{formatCurrency(amcBudgetCheck.committed_so_far)}</span></span>
                    {amcBudgetCheck.provisional_in_pipeline > 0 && (
                      <span className="text-amber-700">In pipeline: <span className="font-semibold">{formatCurrency(amcBudgetCheck.provisional_in_pipeline)}</span></span>
                    )}
                    <span>Remaining: <span className="font-semibold">
                      {formatCurrency(Math.max(0, (amcBudgetCheck.annual_budget ?? 0) - amcBudgetCheck.committed_so_far))}
                    </span></span>
                  </div>
                </>
              ) : (
                <p className="text-xs text-purple-700">No AMC annual budget configured for this financial year. This request will be marked as provisional.</p>
              )}
            </div>
          )}

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="notes">Notes <span className="text-xs text-muted-foreground font-normal">(will carry forward to Purchase Order)</span></Label>
            <Textarea
              id="notes"
              placeholder="Any additional context — this will be visible on the Purchase Order as well..."
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
          <div className="flex gap-2">
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => setItems((prev) => [...prev, { ...emptyItem(), isCustom: true }])}
            >
              <PenLine className="h-4 w-4 mr-1" /> Custom Item
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.map((li, idx) => (
            <div key={li.id} className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">Item {idx + 1}</span>
                <div className="flex gap-2">
                  {!li.isCustom && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openCatalogForItem(li.id)}
                    >
                      <Package className="h-3.5 w-3.5 mr-1" />
                      {li.item_id ? "Change Item" : "Select from Catalog"}
                    </Button>
                  )}
                  {li.isCustom && !li.item_id && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground text-xs h-8"
                      onClick={() => openCatalogForItem(li.id)}
                    >
                      <Package className="h-3.5 w-3.5 mr-1" />
                      Pick from catalog instead
                    </Button>
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

              {/* Status badge */}
              {li.item_id && !li.isCustom && (
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="bg-blue-50 text-blue-700 text-xs">
                    From catalog
                  </Badge>
                  <ItemHistoryDialog itemId={li.item_id} itemName={li.item_name} />
                </div>
              )}

              {li.isCustom && (
                <Badge variant="outline" className="border-orange-300 text-orange-700 text-xs">
                  Custom item
                </Badge>
              )}

              {!li.item_id && !li.isCustom && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                  Please select an item from the catalog using the button above.
                </p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Item Name <span className="text-red-500">*</span></Label>
                  {li.isCustom ? (
                    <Input
                      placeholder="Describe the item (e.g. 5-drawer filing cabinet)"
                      value={li.item_name}
                      onChange={(e) => updateItem(li.id, "item_name", e.target.value)}
                    />
                  ) : (
                    <Input
                      placeholder="Select from catalog to set item name"
                      value={li.item_name}
                      readOnly={true}
                      className="bg-muted/50"
                    />
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Quantity <span className="text-red-500">*</span></Label>
                    <Input
                      type="number"
                      min="1"
                      step="1"
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
                      disabled={!!li.item_id && !li.isCustom}
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

                {/* Price field: visible to admin/manager for catalog items; visible to ALL for custom items */}
                {(canSeePrices || li.isCustom) && (
                  <div className="space-y-1">
                    <Label className="text-xs">
                      Est. Price per Unit (₹){" "}
                      <span className="text-amber-700 font-normal">— pre-GST only</span>
                      {!li.isCustom && li.catalog_standard_price != null && (
                        <span className="ml-1 text-muted-foreground font-normal">
                          — max {formatCurrency(li.catalog_standard_price)}
                        </span>
                      )}
                    </Label>
                    <Input
                      type="number"
                      min="0"
                      max={!li.isCustom && li.catalog_standard_price != null ? li.catalog_standard_price : undefined}
                      step="0.01"
                      placeholder="0.00 (excl. GST)"
                      value={li.estimated_price}
                      className={isPriceOverCeiling(li) ? "border-red-400 focus-visible:ring-red-400" : ""}
                      onChange={(e) => updateItem(li.id, "estimated_price", e.target.value)}
                    />
                    {isPriceOverCeiling(li) && (
                      <p className="text-xs text-red-600 font-medium">
                        ↑ Exceeds catalog price ({formatCurrency(li.catalog_standard_price!)}). Price can only be reduced here — update the catalog to increase it.
                      </p>
                    )}
                  </div>
                )}

                {(canSeePrices || li.isCustom) && li.estimated_price && li.quantity && (
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
                  <Label className="text-xs">Notes <span className="text-muted-foreground">(carries to PO)</span></Label>
                  <Input
                    placeholder="Brand preference, urgency, etc. — visible on PO"
                    value={li.notes}
                    onChange={(e) => updateItem(li.id, "notes", e.target.value)}
                  />
                </div>

                {/* Suggest to catalog checkbox — custom items only */}
                {li.isCustom && (
                  <div className="flex items-center gap-2.5 sm:col-span-2 rounded-md border bg-orange-50/50 border-orange-200 px-3 py-2.5">
                    <Checkbox
                      id={`suggest-${li.id}`}
                      checked={li.suggestCatalog}
                      onCheckedChange={(v) => updateItem(li.id, "suggestCatalog", !!v)}
                    />
                    <label htmlFor={`suggest-${li.id}`} className="text-xs text-muted-foreground cursor-pointer select-none leading-relaxed">
                      Suggest adding this item to the catalog
                      <span className="block text-orange-700/80">Admin will review the suggestion before publishing it</span>
                    </label>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Add Item — bottom buttons so users don't need to scroll up */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 border-dashed"
              onClick={() => {
                const newItem = emptyItem();
                setItems((prev) => [...prev, newItem]);
                setTimeout(() => openCatalogForItem(newItem.id), 0);
              }}
            >
              <Plus className="h-4 w-4 mr-1" /> Add Another Item
            </Button>
            <Button
              variant="outline"
              className="flex-1 border-dashed"
              onClick={() => setItems((prev) => [...prev, { ...emptyItem(), isCustom: true }])}
            >
              <PenLine className="h-4 w-4 mr-1" /> Add Custom Item
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Quotations / Estimates — mandatory before submit */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <CardTitle className="text-base">
              Vendor Quotations / Estimates <span className="text-red-500">*</span>
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Required — attach at least one vendor quotation, estimate, or bill so the approver
              has context. PDF / JPG / PNG / WEBP / HEIC (max 50 MB each).
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={addQuotation}>
            <Plus className="h-4 w-4 mr-1" /> Add Quotation
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {quotations.length === 0 && (
            <div className="rounded-lg border-2 border-dashed border-amber-300 bg-amber-50/40 px-4 py-6 text-center">
              <Paperclip className="h-5 w-5 text-amber-500 mx-auto mb-2" />
              <p className="text-sm font-medium text-amber-800">
                No quotations attached yet
              </p>
              <p className="text-xs text-amber-700 mt-1">
                You can&apos;t save or submit this request until at least one estimate is uploaded.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 border-amber-300"
                onClick={addQuotation}
              >
                <Plus className="h-4 w-4 mr-1" /> Add the first quotation
              </Button>
            </div>
          )}
          {quotations.map((q, idx) => (
            <div key={q.id} className="border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-muted-foreground">
                  Quotation {idx + 1}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => removeQuotation(q.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">
                    Vendor Name <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    placeholder="e.g. ABC Suppliers Pvt Ltd"
                    value={q.vendor_name}
                    onChange={(e) => updateQuotation(q.id, "vendor_name", e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">
                    Quoted Amount (₹){" "}
                    <span className="text-amber-700 font-normal">— incl. taxes is fine</span>{" "}
                    <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={q.amount}
                    onChange={(e) => updateQuotation(q.id, "amount", e.target.value)}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">
                    File <span className="text-red-500">*</span>
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="file"
                      accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
                      onChange={(e) =>
                        setQuotationFile(q.id, e.target.files?.[0] ?? null)
                      }
                    />
                  </div>
                  {q.file && (
                    <p className="text-xs text-muted-foreground">
                      <FileUp className="inline h-3 w-3 mr-1" />
                      {q.file.name} · {(q.file.size / 1024).toFixed(0)} KB
                    </p>
                  )}
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">
                    Notes <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Input
                    placeholder="Discount, validity, lead time…"
                    value={q.notes}
                    onChange={(e) => updateQuotation(q.id, "notes", e.target.value)}
                  />
                </div>
              </div>
            </div>
          ))}
          {quotations.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {validQuotations.length} of {quotations.length} quotation
              {quotations.length === 1 ? "" : "s"} ready to upload.
              {validQuotations.length === 0 && " Each needs a vendor, amount, and file."}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Summary & Actions */}
      <Card>
        <CardContent className="pt-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          {(canSeePrices || items.some((li) => li.isCustom && li.estimated_price)) ? (
            <div>
              <p className="text-sm text-muted-foreground">Total Estimated</p>
              <p className="text-xl font-bold">
                {totalEstimated > 0 ? formatCurrency(totalEstimated) : "—"}
              </p>
            </div>
          ) : (
            <div>
              <p className="text-sm text-muted-foreground">{items.length} item{items.length !== 1 ? "s" : ""} added</p>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleSaveDraft}
              disabled={savingDraft || submitting || validQuotations.length < 1}
              title={
                validQuotations.length < 1
                  ? "Attach at least one quotation / estimate before saving"
                  : undefined
              }
            >
              {savingDraft ? "Saving..." : "Save as Draft"}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={submitting || savingDraft || validQuotations.length < 1}
              title={
                validQuotations.length < 1
                  ? "Attach at least one quotation / estimate before submitting"
                  : undefined
              }
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
              if (target && !target.item_id && !target.item_name.trim() && !target.isCustom && prev.length > 1) {
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

      {/* Price warning dialog — shown when items are submitted without an estimated price */}
      <Dialog open={showPriceWarning} onOpenChange={setShowPriceWarning}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Items missing estimated price
            </DialogTitle>
            <DialogDescription>
              The following items have no estimated price. Without a price the MR total will be
              understated and the linked PO will have ₹0 line items — making it impossible to
              track spend accurately.
            </DialogDescription>
          </DialogHeader>
          <ul className="text-sm rounded-md bg-amber-50 border border-amber-200 px-4 py-3 space-y-1 max-h-40 overflow-y-auto">
            {missingPriceItems.map((name) => (
              <li key={name} className="text-amber-800">• {name}</li>
            ))}
          </ul>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => setShowPriceWarning(false)}
            >
              Go back and fill prices
            </Button>
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              onClick={() => { setShowPriceWarning(false); doSubmit(); }}
            >
              Submit without prices
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pre-GST confirm — soft alert before submit reminding user prices must exclude GST */}
      <Dialog open={showPreGstConfirm} onOpenChange={setShowPreGstConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Confirm prices are pre-GST
            </DialogTitle>
            <DialogDescription>
              Please confirm that every estimated price you entered is the <strong>base amount excluding GST</strong>.
              GST is captured separately when the vendor invoice is recorded — entering GST-inclusive prices here inflates
              budgets and PO ceilings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => setShowPreGstConfirm(false)}
            >
              Go back and check
            </Button>
            <Button
              className="w-full sm:w-auto bg-green-600 hover:bg-green-700"
              onClick={() => {
                setPreGstAcked(true);
                setShowPreGstConfirm(false);
                setTimeout(() => { void doSubmit(); }, 0);
              }}
            >
              Yes, all prices are pre-GST
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
