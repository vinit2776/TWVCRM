"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Save } from "lucide-react";
import { PROCUREMENT_DEPARTMENT_LABELS } from "@/lib/constants";

interface Location {
  id: string;
  name: string;
}

interface ReorderConfigItem {
  item_id: string;
  item_name: string;
  department: string;
  unit: string;
  quantity_on_hand: number;
  reorder_level: number;
}

export function ReorderSettings() {
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [items, setItems] = useState<ReorderConfigItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editedLevels, setEditedLevels] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/locations")
      .then((r) => r.json())
      .then((data) => {
        const locs = data.data || data.locations || [];
        setLocations(locs);
        if (locs.length > 0) setSelectedLocation(locs[0].id);
      })
      .catch(() => toast.error("Failed to load locations"));
  }, []);

  const fetchConfig = useCallback(async () => {
    if (!selectedLocation) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/procurement/reorder-config?location_id=${selectedLocation}`);
      const json = await res.json();
      // API returns { data: [{ item_id, quantity_on_hand, reorder_level, procurement_items: { name, department, unit } }] }
      const rawItems: Array<{
        item_id: string;
        quantity_on_hand: number;
        reorder_level: number;
        procurement_items?: { name?: string; department?: string; unit?: string } | null;
      }> = Array.isArray(json.data) ? json.data : [];

      const configItems: ReorderConfigItem[] = rawItems.map((item) => ({
        item_id: item.item_id,
        item_name: item.procurement_items?.name ?? "Unknown",
        department: item.procurement_items?.department ?? "",
        unit: item.procurement_items?.unit ?? "",
        quantity_on_hand: Number(item.quantity_on_hand ?? 0),
        reorder_level: Number(item.reorder_level ?? 0),
      }));

      setItems(configItems);
      const levels: Record<string, string> = {};
      configItems.forEach((item) => {
        levels[item.item_id] = String(item.reorder_level);
      });
      setEditedLevels(levels);
    } catch {
      toast.error("Failed to load reorder configuration");
    } finally {
      setLoading(false);
    }
  }, [selectedLocation]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const hasChanges = items.some(
    (item) => editedLevels[item.item_id] !== String(item.reorder_level)
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      const configs = items.map((item) => ({
        item_id: item.item_id,
        reorder_level: parseFloat(editedLevels[item.item_id] || "0"),
      }));

      const res = await fetch("/api/procurement/reorder-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location_id: selectedLocation, items: configs }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }

      toast.success("Reorder levels saved successfully");
      fetchConfig();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save reorder levels");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Reorder Level Configuration
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Set minimum stock levels for each item. You will be alerted when stock falls below
          these thresholds during consumption logging.
        </p>

        {/* Location selector */}
        <div className="w-64">
          <Label className="text-sm mb-1.5 block">Location</Label>
          <Select value={selectedLocation} onValueChange={setSelectedLocation}>
            <SelectTrigger>
              <SelectValue placeholder="Select location" />
            </SelectTrigger>
            <SelectContent>
              {locations.map((loc) => (
                <SelectItem key={loc.id} value={loc.id}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Items table */}
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">
            No inventory items found for this location.
          </div>
        ) : (
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 font-medium">Item Name</th>
                  <th className="text-left p-3 font-medium">Department</th>
                  <th className="text-left p-3 font-medium">Unit</th>
                  <th className="text-left p-3 font-medium">Current Stock</th>
                  <th className="text-left p-3 font-medium w-36">Reorder Level</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {items.map((item) => {
                  const isBelowReorder =
                    item.quantity_on_hand > 0 &&
                    item.quantity_on_hand <= parseFloat(editedLevels[item.item_id] || "0");
                  return (
                    <tr key={item.item_id}>
                      <td className="p-3">{item.item_name}</td>
                      <td className="p-3">
                        <Badge variant="secondary" className="text-xs">
                          {PROCUREMENT_DEPARTMENT_LABELS[item.department] || item.department}
                        </Badge>
                      </td>
                      <td className="p-3 text-muted-foreground">{item.unit}</td>
                      <td className="p-3">
                        <span className={isBelowReorder ? "text-amber-600 font-medium" : ""}>
                          {item.quantity_on_hand}
                        </span>
                        {isBelowReorder && (
                          <AlertTriangle className="inline ml-1.5 h-3.5 w-3.5 text-amber-500" />
                        )}
                      </td>
                      <td className="p-3">
                        <Input
                          type="number"
                          min={0}
                          step="any"
                          value={editedLevels[item.item_id] || ""}
                          onChange={(e) =>
                            setEditedLevels((prev) => ({
                              ...prev,
                              [item.item_id]: e.target.value,
                            }))
                          }
                          className="h-8"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Save button */}
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving || !hasChanges}>
            {saving ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-1.5" />
            )}
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
