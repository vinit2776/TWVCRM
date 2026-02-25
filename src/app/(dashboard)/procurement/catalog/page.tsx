"use client";

import { useState, useEffect, useCallback } from "react";
import { Archive, Plus, X, Check } from "lucide-react";
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
} from "@/lib/constants";
import { toast } from "sonner";
import type { ProcurementItem, ProcurementDepartment, ItemUnit } from "@/types";

const emptyForm = {
  name: "",
  department: "pantry" as ProcurementDepartment,
  unit: "piece" as ItemUnit,
  standard_price: "",
  description: "",
};

export default function CatalogPage() {
  const [items, setItems] = useState<ProcurementItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deptFilter, setDeptFilter] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (deptFilter) params.set("department", deptFilter);
    if (includeInactive) params.set("include_inactive", "true");
    const res = await fetch(`/api/procurement/items?${params}`);
    if (res.ok) { const json = await res.json(); setItems(json.data || []); }
    setLoading(false);
  }, [deptFilter, includeInactive]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  async function handleCreate() {
    if (!form.name.trim()) { toast.error("Item name is required"); return; }
    setSaving(true);
    const res = await fetch("/api/procurement/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name.trim(),
        department: form.department,
        unit: form.unit,
        standard_price: form.standard_price ? Number(form.standard_price) : undefined,
        description: form.description || undefined,
      }),
    });
    if (res.ok) {
      toast.success("Item added to catalog");
      setDialogOpen(false);
      setForm(emptyForm);
      fetchItems();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Failed to add item");
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

  // Group items by department
  const grouped = PROCUREMENT_DEPARTMENTS.reduce<Record<string, ProcurementItem[]>>((acc, dept) => {
    acc[dept] = items.filter((i) => i.department === dept);
    return acc;
  }, {} as Record<string, ProcurementItem[]>);

  const activeDepts = deptFilter
    ? PROCUREMENT_DEPARTMENTS.filter((d) => d === deptFilter)
    : PROCUREMENT_DEPARTMENTS;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Item Catalog</h1>
          <p className="text-sm text-muted-foreground">{items.length} item{items.length !== 1 ? "s" : ""} across all departments</p>
        </div>
        <Button onClick={() => setDialogOpen(true)} className="shrink-0">
          <Plus className="h-4 w-4 mr-2" /> Add Item
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
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
                          <th className="text-left px-4 py-2 font-medium">Unit</th>
                          <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Std. Price</th>
                          <th className="text-left px-4 py-2 font-medium">Status</th>
                          <th className="px-4 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {deptItems.map((item) => (
                          <tr key={item.id} className="border-b last:border-0 hover:bg-muted/20">
                            <td className="px-4 py-2.5">
                              <span className={item.is_active ? "" : "text-muted-foreground line-through"}>
                                {item.name}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-muted-foreground">{item.unit}</td>
                            <td className="px-4 py-2.5 hidden md:table-cell text-muted-foreground">
                              {item.standard_price != null ? `₹${item.standard_price}` : "—"}
                            </td>
                            <td className="px-4 py-2.5">
                              <Badge className={item.is_active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}>
                                {item.is_active ? "Active" : "Inactive"}
                              </Badge>
                            </td>
                            <td className="px-4 py-2.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => toggleActive(item)}
                                title={item.is_active ? "Deactivate" : "Reactivate"}
                              >
                                {item.is_active
                                  ? <X className="h-3 w-3 text-red-500" />
                                  : <Check className="h-3 w-3 text-green-600" />}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add Item Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Item to Catalog</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Item Name *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Premium Coffee Beans"
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
            <div className="space-y-1">
              <Label>Standard Price (₹) <span className="text-muted-foreground text-xs">optional reference</span></Label>
              <Input
                type="number" min="0" step="0.01"
                value={form.standard_price}
                onChange={(e) => setForm((f) => ({ ...f, standard_price: e.target.value }))}
                placeholder="0.00"
              />
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
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? "Adding..." : "Add Item"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
