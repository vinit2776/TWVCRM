"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Pencil } from "lucide-react";
import { toast } from "sonner";
import { LocationSelector } from "@/components/shared/location-selector";
import { formatCurrency } from "@/lib/utils";

interface FacilityCatalogItem {
  id: string;
  location_id: string;
  name: string;
  unit: string;
  default_cost_per_unit: number;
  is_active: boolean;
}

const BLANK_FORM = { name: "", unit: "hr", default_cost_per_unit: "" };

export function FacilityCatalogSettings() {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [items, setItems] = useState<FacilityCatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FacilityCatalogItem | null>(null);
  const [form, setForm] = useState(BLANK_FORM);
  const [saving, setSaving] = useState(false);

  const fetchItems = useCallback(async () => {
    if (!locationId) { setItems([]); return; }
    setLoading(true);
    const res = await fetch(`/api/facility-catalog?location_id=${locationId}&include_inactive=true`);
    if (res.ok) {
      const json = await res.json();
      setItems(json.data || []);
    }
    setLoading(false);
  }, [locationId]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const openNew = () => {
    setEditing(null);
    setForm(BLANK_FORM);
    setDialogOpen(true);
  };

  const openEdit = (item: FacilityCatalogItem) => {
    setEditing(item);
    setForm({ name: item.name, unit: item.unit, default_cost_per_unit: String(item.default_cost_per_unit) });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    if (!form.unit.trim()) { toast.error("Unit is required"); return; }
    const rate = parseFloat(form.default_cost_per_unit) || 0;

    setSaving(true);
    try {
      if (editing) {
        const res = await fetch(`/api/facility-catalog/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: form.name.trim(), unit: form.unit.trim(), default_cost_per_unit: rate }),
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Failed to update"); }
        toast.success("Facility updated");
      } else {
        const res = await fetch("/api/facility-catalog", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ location_id: locationId, name: form.name.trim(), unit: form.unit.trim(), default_cost_per_unit: rate }),
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error || "Failed to add"); }
        toast.success("Facility added");
      }
      setDialogOpen(false);
      fetchItems();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (item: FacilityCatalogItem) => {
    const res = await fetch(`/api/facility-catalog/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !item.is_active }),
    });
    if (res.ok) {
      toast.success(item.is_active ? "Facility deactivated" : "Facility activated");
      fetchItems();
    } else {
      toast.error("Failed to toggle");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-3">
        <CardTitle className="text-base">Facility Catalogue</CardTitle>
        <div className="flex items-center gap-3">
          <LocationSelector value={locationId} onValueChange={setLocationId} placeholder="Select location..." />
          {locationId && (
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4 mr-1" />Add Facility
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!locationId ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            Select a location to manage its facility catalogue.
          </p>
        ) : loading ? (
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map((i) => <div key={i} className="h-12 rounded bg-muted" />)}
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">
            No facilities configured for this location. Click &ldquo;Add Facility&rdquo; to create one.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="pb-2 font-medium text-muted-foreground">Facility Name</th>
                  <th className="pb-2 font-medium text-muted-foreground">Unit</th>
                  <th className="pb-2 font-medium text-muted-foreground text-right">Default Rate</th>
                  <th className="pb-2 font-medium text-muted-foreground text-center">Active</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className={`border-b last:border-0 hover:bg-muted/30 ${!item.is_active ? "opacity-50" : ""}`}>
                    <td className="py-2.5 font-medium">{item.name}</td>
                    <td className="py-2.5">
                      <Badge variant="outline" className="text-xs">{item.unit}</Badge>
                    </td>
                    <td className="py-2.5 text-right font-mono">
                      {Number(item.default_cost_per_unit) > 0
                        ? `${formatCurrency(Number(item.default_cost_per_unit))}/${item.unit}`
                        : "Free"}
                    </td>
                    <td className="py-2.5 text-center">
                      <Switch checked={item.is_active} onCheckedChange={() => toggleActive(item)} />
                    </td>
                    <td className="py-2.5">
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => openEdit(item)}>
                        <Pencil className="h-3 w-3 mr-1" />Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing ? "Edit Facility" : "Add Facility"}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Facility Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Conference Room A"
                  disabled={saving}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Unit</Label>
                  <Input
                    value={form.unit}
                    onChange={(e) => setForm({ ...form, unit: e.target.value })}
                    placeholder="hr"
                    disabled={saving}
                  />
                  <p className="text-xs text-muted-foreground">e.g. hr, day, session</p>
                </div>
                <div className="space-y-2">
                  <Label>Default Rate (₹ per unit)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.default_cost_per_unit}
                    onChange={(e) => setForm({ ...form, default_cost_per_unit: e.target.value })}
                    placeholder="0 = free"
                    disabled={saving}
                  />
                </div>
              </div>
              <Button onClick={handleSave} className="w-full" disabled={saving}>
                {saving ? "Saving…" : editing ? "Save Changes" : "Add Facility"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
