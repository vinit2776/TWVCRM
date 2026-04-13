"use client";

import { useState, useEffect, useCallback } from "react";
import { Archive, Pencil, Plus, X, Check, Search, History, AlertTriangle, TrendingUp, TrendingDown, Minus } from "lucide-react";
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
import { EmptyState } from "@/components/shared/empty-state";
import { TableSkeleton } from "@/components/shared/loading-skeleton";
import {
  PROCUREMENT_DEPARTMENTS,
  PROCUREMENT_DEPARTMENT_LABELS,
  PROCUREMENT_DEPARTMENT_COLORS,
  ITEM_UNITS,
  ITEM_TYPES,
  ITEM_TYPE_LABELS,
  GST_RATES,
  GST_RATE_LABELS,
} from "@/lib/constants";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { ProcurementItem, ProcurementDepartment, ItemUnit, ItemType } from "@/types";

// ── Types ──────────────────────────────────────────────────────────────────────

interface PriceHistoryEntry {
  id: string;
  old_price: number | null;
  new_price: number | null;
  changed_at: string;
  notes: string | null;
  changer: { id: string; full_name?: string; email?: string } | null;
}

const emptyForm = {
  name: "",
  department: "pantry" as ProcurementDepartment,
  unit: "piece" as ItemUnit,
  item_type: "goods" as ItemType,
  standard_price: "",
  gst_rate: "0",
  description: "",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Groups items by lower-cased trimmed name, returns names that appear more than once. */
function detectDuplicates(items: ProcurementItem[]): Set<string> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item.name.trim().toLowerCase();
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return new Set(Object.entries(counts).filter(([, c]) => c > 1).map(([k]) => k));
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function CatalogPage() {
  const [items, setItems] = useState<ProcurementItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deptFilter, setDeptFilter] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [search, setSearch] = useState("");

  // Add / Edit dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editItem, setEditItem] = useState<ProcurementItem | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  // Price history dialog
  const [historyItem, setHistoryItem] = useState<ProcurementItem | null>(null);
  const [historyData, setHistoryData] = useState<PriceHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // ── Data fetching ────────────────────────────────────────────────────────────

  const fetchItems = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (deptFilter) params.set("department", deptFilter);
    if (includeInactive) params.set("include_inactive", "true");
    if (search.trim()) params.set("search", search.trim());
    const res = await fetch(`/api/procurement/items?${params}`);
    if (res.ok) { const json = await res.json(); setItems(json.data || []); }
    setLoading(false);
  }, [deptFilter, includeInactive, search]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  // Always fetch all items (without search filter) to detect duplicates globally
  const [allItems, setAllItems] = useState<ProcurementItem[]>([]);
  useEffect(() => {
    fetch("/api/procurement/items?include_inactive=true")
      .then((r) => r.json())
      .then((j) => setAllItems(j.data || []));
  }, [items]); // re-check after any save

  const duplicateNames = detectDuplicates(allItems);
  const hasDuplicates = duplicateNames.size > 0;

  // ── Price history ────────────────────────────────────────────────────────────

  const openPriceHistory = async (item: ProcurementItem) => {
    setHistoryItem(item);
    setHistoryData([]);
    setHistoryLoading(true);
    const res = await fetch(`/api/procurement/items/${item.id}/price-history`);
    if (res.ok) setHistoryData((await res.json()).data || []);
    setHistoryLoading(false);
  };

  // ── Edit ─────────────────────────────────────────────────────────────────────

  function openEdit(item: ProcurementItem) {
    setEditItem(item);
    setForm({
      name: item.name,
      department: item.department,
      unit: item.unit,
      item_type: item.item_type ?? "goods",
      standard_price: item.standard_price != null ? String(item.standard_price) : "",
      gst_rate: item.gst_rate != null ? String(item.gst_rate) : "0",
      description: item.description || "",
    });
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error("Item name is required"); return; }
    setSaving(true);
    const body = {
      name: form.name.trim(),
      department: form.department,
      unit: form.unit,
      item_type: form.item_type,
      standard_price: form.standard_price ? Number(form.standard_price) : undefined,
      gst_rate: Number(form.gst_rate) || 0,
      description: form.description || undefined,
    };
    const res = editItem
      ? await fetch(`/api/procurement/items/${editItem.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      : await fetch("/api/procurement/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
    if (res.ok) {
      toast.success(editItem ? "Item updated" : "Item added to catalog");
      setDialogOpen(false);
      setEditItem(null);
      setForm(emptyForm);
      fetchItems();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || (editItem ? "Failed to update item" : "Failed to add item"));
    }
    setSaving(false);
  }

  async function toggleActive(item: ProcurementItem) {
    const res = await fetch(`/api/procurement/items/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !item.is_active }),
    });
    if (res.ok) {
      toast.success(item.is_active ? "Item deactivated" : "Item reactivated");
      fetchItems();
    } else {
      toast.error("Failed to update item");
    }
  }

  // ── Grouping ─────────────────────────────────────────────────────────────────

  const grouped = PROCUREMENT_DEPARTMENTS.reduce<Record<string, ProcurementItem[]>>((acc, dept) => {
    acc[dept] = items.filter((i) => i.department === dept);
    return acc;
  }, {} as Record<string, ProcurementItem[]>);

  const activeDepts = deptFilter
    ? PROCUREMENT_DEPARTMENTS.filter((d) => d === deptFilter)
    : PROCUREMENT_DEPARTMENTS;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Item Catalog</h1>
          <p className="text-sm text-muted-foreground">
            {items.length} item{items.length !== 1 ? "s" : ""}
            {search.trim() ? ` matching "${search.trim()}"` : " across all departments"}
          </p>
        </div>
        <Button onClick={() => { setEditItem(null); setForm(emptyForm); setDialogOpen(true); }} className="shrink-0">
          <Plus className="h-4 w-4 mr-2" /> Add Item
        </Button>
      </div>

      {/* Duplicate names warning banner */}
      {hasDuplicates && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1 text-sm">
            <p className="font-semibold text-amber-800">Duplicate item names detected</p>
            <p className="text-amber-700 mt-0.5">
              The following names appear more than once and must be made unique before a uniqueness constraint can be enforced:{" "}
              {[...duplicateNames].map((n, i) => (
                <span key={n}>
                  <span className="font-medium">"{n}"</span>
                  {i < duplicateNames.size - 1 ? ", " : ""}
                </span>
              ))}
            </p>
            <p className="text-amber-600 mt-1 text-xs">
              Edit or deactivate the duplicate entries using the pencil icon below.
            </p>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search items..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Select value={deptFilter} onValueChange={(v) => setDeptFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="All Departments" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Departments</SelectItem>
            {PROCUREMENT_DEPARTMENTS.map((d) => (
              <SelectItem key={d} value={d}>{PROCUREMENT_DEPARTMENT_LABELS[d]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={includeInactive ? "default" : "outline"}
          size="sm"
          onClick={() => setIncludeInactive((v) => !v)}
        >
          {includeInactive ? "Hide Inactive" : "Show Inactive"}
        </Button>
      </div>

      {/* Content */}
      {loading ? <TableSkeleton rows={8} /> : items.length === 0 ? (
        <EmptyState
          icon={Archive}
          title="No items found"
          description="The item catalog is pre-seeded. Adjust filters or add a new item."
        />
      ) : (
        <div className="space-y-6">
          {activeDepts.map((dept) => {
            const deptItems = grouped[dept] || [];
            if (deptItems.length === 0) return null;
            return (
              <Card key={dept}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Badge className={PROCUREMENT_DEPARTMENT_COLORS[dept]}>
                      {PROCUREMENT_DEPARTMENT_LABELS[dept]}
                    </Badge>
                    <span className="text-muted-foreground text-sm font-normal">
                      {deptItems.length} item{deptItems.length !== 1 ? "s" : ""}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-y bg-muted/30">
                        <tr>
                          <th className="text-left px-4 py-2 font-medium">Item Name</th>
                          <th className="text-left px-4 py-2 font-medium hidden sm:table-cell">Type</th>
                          <th className="text-left px-4 py-2 font-medium">Unit</th>
                          <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Std. Price</th>
                          <th className="text-left px-4 py-2 font-medium hidden md:table-cell">GST</th>
                          <th className="text-left px-4 py-2 font-medium">Status</th>
                          <th className="px-4 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {deptItems.map((item) => {
                          const isDuplicate = duplicateNames.has(item.name.trim().toLowerCase());
                          return (
                            <tr key={item.id} className={`border-b last:border-0 hover:bg-muted/20 ${isDuplicate ? "bg-amber-50/40" : ""}`}>
                              <td className="px-4 py-2.5">
                                <div className="flex items-center gap-2">
                                  <span className={item.is_active ? "" : "text-muted-foreground line-through"}>
                                    {item.name}
                                  </span>
                                  {isDuplicate && (
                                    <Badge className="text-[10px] bg-amber-100 text-amber-800 border-amber-200 border px-1.5 py-0">
                                      duplicate
                                    </Badge>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-2.5 hidden sm:table-cell">
                                <Badge className={item.item_type === "service" ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-700"}>
                                  {ITEM_TYPE_LABELS[item.item_type ?? "goods"]}
                                </Badge>
                              </td>
                              <td className="px-4 py-2.5 text-muted-foreground">{item.unit}</td>
                              <td className="px-4 py-2.5 hidden md:table-cell text-muted-foreground">
                                {item.standard_price != null ? formatCurrency(item.standard_price) : "—"}
                              </td>
                              <td className="px-4 py-2.5 hidden md:table-cell text-muted-foreground">
                                {item.gst_rate ? `${item.gst_rate}%` : "—"}
                              </td>
                              <td className="px-4 py-2.5">
                                <Badge className={item.is_active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}>
                                  {item.is_active ? "Active" : "Inactive"}
                                </Badge>
                              </td>
                              <td className="px-4 py-2.5">
                                <div className="flex items-center gap-0.5">
                                  {/* Price history */}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => openPriceHistory(item)}
                                    title="Price history"
                                    className="h-7 w-7 p-0"
                                  >
                                    <History className="h-3.5 w-3.5 text-muted-foreground" />
                                  </Button>
                                  {/* Edit */}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => openEdit(item)}
                                    title="Edit item"
                                    className="h-7 w-7 p-0"
                                  >
                                    <Pencil className="h-3 w-3 text-muted-foreground" />
                                  </Button>
                                  {/* Toggle active */}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => toggleActive(item)}
                                    title={item.is_active ? "Deactivate" : "Reactivate"}
                                    className="h-7 w-7 p-0"
                                  >
                                    {item.is_active
                                      ? <X className="h-3 w-3 text-red-500" />
                                      : <Check className="h-3 w-3 text-green-600" />}
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Add / Edit Item Dialog ── */}
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) { setEditItem(null); setForm(emptyForm); }
          setDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editItem ? "Edit Item" : "Add Item to Catalog"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Item type toggle */}
            <div className="space-y-1">
              <Label>Item Type *</Label>
              <div className="flex gap-2">
                {ITEM_TYPES.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, item_type: t }))}
                    className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                      form.item_type === t
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background hover:bg-muted border-input"
                    }`}
                  >
                    {ITEM_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <Label>Item Name *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={form.item_type === "service" ? "e.g. Generator Maintenance" : "e.g. Premium Coffee Beans"}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Department *</Label>
                <Select
                  value={form.department}
                  onValueChange={(v) => setForm((f) => ({ ...f, department: v as ProcurementDepartment }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROCUREMENT_DEPARTMENTS.map((d) => (
                      <SelectItem key={d} value={d}>{PROCUREMENT_DEPARTMENT_LABELS[d]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Unit *</Label>
                <Select
                  value={form.unit}
                  onValueChange={(v) => setForm((f) => ({ ...f, unit: v as ItemUnit }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ITEM_UNITS.map((u) => (
                      <SelectItem key={u} value={u}>{u}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>
                  Standard Price (₹){" "}
                  <span className="text-muted-foreground text-xs font-normal">optional</span>
                </Label>
                <Input
                  type="number" min="0" step="0.01"
                  value={form.standard_price}
                  onChange={(e) => setForm((f) => ({ ...f, standard_price: e.target.value }))}
                  placeholder="0.00"
                />
                {editItem && (
                  <p className="text-xs text-muted-foreground">
                    Current: {editItem.standard_price != null ? formatCurrency(editItem.standard_price) : "—"}
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <Label>GST Rate</Label>
                <Select value={form.gst_rate} onValueChange={(v) => setForm((f) => ({ ...f, gst_rate: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {GST_RATES.map((r) => (
                      <SelectItem key={r} value={String(r)}>{GST_RATE_LABELS[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <Label>Item Notes</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Handling instructions, specifications, ordering notes..."
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving
                ? (editItem ? "Saving..." : "Adding...")
                : (editItem ? "Save Changes" : "Add Item")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Price History Dialog ── */}
      <Dialog
        open={!!historyItem}
        onOpenChange={(open) => { if (!open) { setHistoryItem(null); setHistoryData([]); } }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-4 w-4" />
              Price History — {historyItem?.name}
            </DialogTitle>
          </DialogHeader>

          <div className="py-1">
            {/* Current price */}
            <div className="flex items-center justify-between rounded-lg bg-muted/40 border px-4 py-2.5 mb-4">
              <span className="text-sm text-muted-foreground">Current standard price</span>
              <span className="font-semibold text-base">
                {historyItem?.standard_price != null
                  ? formatCurrency(historyItem.standard_price)
                  : <span className="text-muted-foreground">Not set</span>}
              </span>
            </div>

            {historyLoading ? (
              <p className="text-sm text-muted-foreground text-center py-8">Loading history...</p>
            ) : historyData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No price changes recorded yet. Price updates will appear here.
              </p>
            ) : (
              <div className="space-y-0 border rounded-lg overflow-hidden">
                {historyData.map((entry, idx) => {
                  const oldP = entry.old_price != null ? Number(entry.old_price) : null;
                  const newP = entry.new_price != null ? Number(entry.new_price) : null;
                  const increased = oldP != null && newP != null && newP > oldP;
                  const decreased = oldP != null && newP != null && newP < oldP;
                  return (
                    <div
                      key={entry.id}
                      className={`flex items-start gap-3 px-4 py-3 text-sm ${idx !== historyData.length - 1 ? "border-b" : ""}`}
                    >
                      {/* Trend icon */}
                      <div className="mt-0.5 shrink-0">
                        {increased ? (
                          <TrendingUp className="h-4 w-4 text-green-600" />
                        ) : decreased ? (
                          <TrendingDown className="h-4 w-4 text-red-500" />
                        ) : (
                          <Minus className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-muted-foreground">
                            {oldP != null ? formatCurrency(oldP) : "—"}
                          </span>
                          <span className="text-muted-foreground">→</span>
                          <span className={`font-semibold ${increased ? "text-green-700" : decreased ? "text-red-600" : ""}`}>
                            {newP != null ? formatCurrency(newP) : "—"}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {entry.changer?.full_name ?? entry.changer?.email ?? "Unknown user"}
                          {" · "}
                          {formatDate(entry.changed_at)}
                        </div>
                        {entry.notes && (
                          <p className="text-xs text-muted-foreground italic mt-0.5">{entry.notes}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setHistoryItem(null); setHistoryData([]); }}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
