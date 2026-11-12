"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { preventEnterSubmit } from "@/lib/utils";
import type { LocationFloor } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationId: string;
  floor?: LocationFloor | null;
  onSuccess: (floor: LocationFloor) => void;
}

export function FloorFormDialog({ open, onOpenChange, locationId, floor, onSuccess }: Props) {
  const isEdit = Boolean(floor);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: "",
    floor_number: "",
    total_area_sqft: "",
    leasable_area_sqft: "",
    grid_cols: "20",
    grid_rows: "12",
    sort_order: "0",
  });

  useEffect(() => {
    if (floor) {
      setForm({
        name: floor.name,
        floor_number: floor.floor_number !== null && floor.floor_number !== undefined ? String(floor.floor_number) : "",
        total_area_sqft: String(floor.total_area_sqft || ""),
        leasable_area_sqft: String(floor.leasable_area_sqft || ""),
        grid_cols: String(floor.grid_cols || 20),
        grid_rows: String(floor.grid_rows || 12),
        sort_order: String(floor.sort_order || 0),
      });
    } else {
      setForm({ name: "", floor_number: "", total_area_sqft: "", leasable_area_sqft: "", grid_cols: "20", grid_rows: "12", sort_order: "0" });
    }
  }, [floor, open]);

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { toast.error("Floor name is required"); return; }

    const gridCols = Number(form.grid_cols);
    const gridRows = Number(form.grid_rows);
    if (gridCols < 10 || gridCols > 30) { toast.error("Grid columns must be 10–30"); return; }
    if (gridRows < 8 || gridRows > 20) { toast.error("Grid rows must be 8–20"); return; }

    const totalArea = Number(form.total_area_sqft || 0);
    const leasableArea = Number(form.leasable_area_sqft || 0);
    if (leasableArea > totalArea && totalArea > 0) { toast.error("Leasable area cannot exceed total area"); return; }

    setLoading(true);
    try {
      const url = isEdit
        ? `/api/locations/${locationId}/floors/${floor!.id}`
        : `/api/locations/${locationId}/floors`;
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          floor_number: form.floor_number !== "" ? Number(form.floor_number) : null,
          total_area_sqft: totalArea,
          leasable_area_sqft: leasableArea,
          grid_cols: gridCols,
          grid_rows: gridRows,
          sort_order: Number(form.sort_order || 0),
        }),
      });

      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to save floor"); return; }

      toast.success(isEdit ? "Floor updated" : "Floor added");
      onSuccess(json.data);
      onOpenChange(false);
    } catch {
      toast.error("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  const cols = Number(form.grid_cols) || 20;
  const rows = Number(form.grid_rows) || 12;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Floor" : "Add Floor"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} onKeyDown={preventEnterSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-1">
              <Label htmlFor="name">Floor Name *</Label>
              <Input id="name" value={form.name} onChange={set("name")} placeholder="e.g. Ground Floor, 1st Floor" />
            </div>

            <div className="space-y-1">
              <Label htmlFor="floor_number">Floor Number</Label>
              <Input id="floor_number" type="number" value={form.floor_number} onChange={set("floor_number")}
                placeholder="0 = ground, -1 = basement" />
            </div>

            <div className="space-y-1">
              <Label htmlFor="sort_order">Display Order</Label>
              <Input id="sort_order" type="number" value={form.sort_order} onChange={set("sort_order")} min={0} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="total_area_sqft">Total Area (sqft)</Label>
              <Input id="total_area_sqft" type="number" value={form.total_area_sqft} onChange={set("total_area_sqft")} placeholder="Built-up area" min={0} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="leasable_area_sqft">Leasable Area (sqft)</Label>
              <Input id="leasable_area_sqft" type="number" value={form.leasable_area_sqft} onChange={set("leasable_area_sqft")} placeholder="Carpet / usable area" min={0} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="grid_cols">Canvas Columns</Label>
              <Input id="grid_cols" type="number" value={form.grid_cols} onChange={set("grid_cols")} min={10} max={30} />
              <p className="text-xs text-muted-foreground">10–30 columns</p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="grid_rows">Canvas Rows</Label>
              <Input id="grid_rows" type="number" value={form.grid_rows} onChange={set("grid_rows")} min={8} max={20} />
              <p className="text-xs text-muted-foreground">8–20 rows</p>
            </div>
          </div>

          {/* Canvas preview */}
          <div className="rounded border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground mb-2 font-medium">Canvas preview</p>
            <div
              className="border border-dashed border-muted-foreground/30 rounded mx-auto"
              style={{
                width: `${Math.min(cols * 8, 280)}px`,
                height: `${Math.min(rows * 8, 140)}px`,
                backgroundImage: `repeating-linear-gradient(to right, #e5e7eb 0, #e5e7eb 1px, transparent 1px, transparent ${Math.min(cols * 8, 280) / cols}px),
                  repeating-linear-gradient(to bottom, #e5e7eb 0, #e5e7eb 1px, transparent 1px, transparent ${Math.min(rows * 8, 140) / rows}px)`,
              }}
            />
            <p className="text-xs text-muted-foreground text-center mt-1">{cols} × {rows} = {cols * rows} cells</p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? "Saving…" : isEdit ? "Save Changes" : "Add Floor"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
