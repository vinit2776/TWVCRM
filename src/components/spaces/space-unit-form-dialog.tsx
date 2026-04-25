"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import type { SpaceUnit, SpaceUnitType, LocationFloor } from "@/types";

const UNIT_TYPES: { value: SpaceUnitType; label: string; defaultCap: number; isHourly: boolean }[] = [
  { value: "hot_desk",        label: "Hot Desk",          defaultCap: 1, isHourly: false },
  { value: "dedicated_desk",  label: "Dedicated Desk",    defaultCap: 1, isHourly: false },
  { value: "private_cabin",   label: "Private Cabin",     defaultCap: 2, isHourly: false },
  { value: "managed_office",  label: "Managed Office",    defaultCap: 8, isHourly: false },
  { value: "business_centre", label: "Business Centre",   defaultCap: 1, isHourly: true  },
];

function isHourlyType(t: SpaceUnitType): boolean {
  return UNIT_TYPES.find((u) => u.value === t)?.isHourly === true;
}

const AMENITIES_OPTIONS = ["AC", "Whiteboard", "TV / Screen", "Phone", "Storage", "Standing Desk", "Natural Light", "Soundproofing"];

const PALETTE = [
  "#e0f2fe", "#bfdbfe", "#ede9fe", "#fce7f3",
  "#dcfce7", "#fef9c3", "#ffedd5", "#f1f5f9",
];

interface GridSelection {
  gridCol: number;
  gridRow: number;
  gridColSpan: number;
  gridRowSpan: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationId: string;
  floor: LocationFloor | null;
  unit?: SpaceUnit | null;
  gridSelection?: GridSelection | null;
  onSuccess: (unit: SpaceUnit) => void;
}

export function SpaceUnitFormDialog({ open, onOpenChange, locationId, floor, unit, gridSelection, onSuccess }: Props) {
  const isEdit = Boolean(unit);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: "",
    code: "",
    type: "private_cabin" as SpaceUnitType,
    capacity: "2",
    area_sqft: "",
    monthly_rate: "",
    daily_rate: "",
    hourly_rate: "",
    amenities: [] as string[],
    notes: "",
    color: PALETTE[2],
    grid_col: "1",
    grid_row: "1",
    grid_col_span: "2",
    grid_row_span: "2",
  });

  useEffect(() => {
    if (!open) return;
    if (unit) {
      setForm({
        name: unit.name,
        code: unit.code,
        type: unit.type,
        capacity: String(unit.capacity),
        area_sqft: unit.area_sqft ? String(unit.area_sqft) : "",
        monthly_rate: unit.monthly_rate ? String(unit.monthly_rate) : "",
        daily_rate: unit.daily_rate ? String(unit.daily_rate) : "",
        hourly_rate: unit.hourly_rate ? String(unit.hourly_rate) : "",
        amenities: unit.amenities || [],
        notes: unit.notes || "",
        color: unit.color || PALETTE[2],
        grid_col: String(unit.grid_col),
        grid_row: String(unit.grid_row),
        grid_col_span: String(unit.grid_col_span),
        grid_row_span: String(unit.grid_row_span),
      });
    } else {
      const defaultType = UNIT_TYPES[2];
      setForm({
        name: "",
        code: "",
        type: defaultType.value,
        capacity: String(defaultType.defaultCap),
        area_sqft: "",
        monthly_rate: "",
        daily_rate: "",
        hourly_rate: "",
        amenities: [],
        notes: "",
        color: PALETTE[2],
        grid_col: String(gridSelection?.gridCol ?? 1),
        grid_row: String(gridSelection?.gridRow ?? 1),
        grid_col_span: String(gridSelection?.gridColSpan ?? 2),
        grid_row_span: String(gridSelection?.gridRowSpan ?? 2),
      });
    }
  }, [unit, gridSelection, open]);

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  function toggleAmenity(a: string) {
    setForm((f) => ({
      ...f,
      amenities: f.amenities.includes(a) ? f.amenities.filter((x) => x !== a) : [...f.amenities, a],
    }));
  }

  const hourly = isHourlyType(form.type);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    if (!form.code.trim()) { toast.error("Code is required"); return; }
    if (hourly) {
      if (!form.hourly_rate || isNaN(Number(form.hourly_rate))) { toast.error("Hourly rate is required"); return; }
    } else {
      if (!form.monthly_rate || isNaN(Number(form.monthly_rate))) { toast.error("Monthly rate is required"); return; }
    }

    setLoading(true);
    try {
      const url = isEdit
        ? `/api/locations/${locationId}/space-units/${unit!.id}`
        : `/api/locations/${locationId}/space-units`;
      const method = isEdit ? "PUT" : "POST";

      const payload = {
        floor_id: floor?.id ?? null,
        name: form.name.trim(),
        code: form.code.trim(),
        type: form.type,
        capacity: Number(form.capacity),
        area_sqft: form.area_sqft ? Number(form.area_sqft) : null,
        monthly_rate: hourly ? null : Number(form.monthly_rate),
        daily_rate: form.daily_rate ? Number(form.daily_rate) : null,
        hourly_rate: form.hourly_rate ? Number(form.hourly_rate) : null,
        amenities: form.amenities,
        notes: form.notes || null,
        color: form.color || null,
        grid_col: Number(form.grid_col),
        grid_row: Number(form.grid_row),
        grid_col_span: Number(form.grid_col_span),
        grid_row_span: Number(form.grid_row_span),
      };

      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to save space unit"); return; }

      toast.success(isEdit ? "Space unit updated" : "Space unit added");
      onSuccess(json.data);
      onOpenChange(false);
    } catch {
      toast.error("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Space Unit" : "Add Space Unit"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Identity */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Unit Name *</Label>
              <Input value={form.name} onChange={set("name")} placeholder="e.g. Cabin 03" />
            </div>
            <div className="space-y-1">
              <Label>Code *</Label>
              <Input value={form.code} onChange={set("code")} placeholder="C-03" className="uppercase"
                onBlur={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} />
            </div>
          </div>

          {/* Type + Capacity */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Type *</Label>
              <Select value={form.type} onValueChange={(v) => {
                const def = UNIT_TYPES.find((t) => t.value === v);
                setForm((f) => ({ ...f, type: v as SpaceUnitType, capacity: def ? String(def.defaultCap) : f.capacity }));
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {UNIT_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Capacity (seats) *</Label>
              <Input type="number" value={form.capacity} onChange={set("capacity")} min={1} />
            </div>
          </div>

          {/* Rates — switches between monthly and hourly based on type */}
          {hourly ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Hourly Rate (₹) *</Label>
                <Input type="number" value={form.hourly_rate} onChange={set("hourly_rate")} placeholder="350" min={0} />
              </div>
              <div className="space-y-1">
                <Label>Daily Rate (₹)</Label>
                <Input type="number" value={form.daily_rate} onChange={set("daily_rate")} placeholder="Optional" min={0} />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Monthly Rate (₹) *</Label>
                <Input type="number" value={form.monthly_rate} onChange={set("monthly_rate")} placeholder="18000" min={0} />
              </div>
              <div className="space-y-1">
                <Label>Daily Rate (₹)</Label>
                <Input type="number" value={form.daily_rate} onChange={set("daily_rate")} placeholder="Optional" min={0} />
              </div>
            </div>
          )}
          {hourly && (
            <p className="text-xs text-muted-foreground -mt-2">
              Business centres are billed hourly — typically used for short-term, walk-in, or pay-per-use bookings.
            </p>
          )}

          {/* Area */}
          <div className="space-y-1">
            <Label>Area (sqft)</Label>
            <Input type="number" value={form.area_sqft} onChange={set("area_sqft")} placeholder="e.g. 180" min={0} />
          </div>

          {/* Amenities */}
          <div className="space-y-2">
            <Label>Amenities</Label>
            <div className="grid grid-cols-2 gap-2">
              {AMENITIES_OPTIONS.map((a) => (
                <div key={a} className="flex items-center gap-2">
                  <Checkbox id={`am-${a}`} checked={form.amenities.includes(a)} onCheckedChange={() => toggleAmenity(a)} />
                  <label htmlFor={`am-${a}`} className="text-sm cursor-pointer">{a}</label>
                </div>
              ))}
            </div>
          </div>

          {/* Color */}
          <div className="space-y-2">
            <Label>Colour</Label>
            <div className="flex gap-2 flex-wrap">
              {PALETTE.map((c) => (
                <button
                  key={c} type="button"
                  className={`w-7 h-7 rounded-full border-2 transition-transform ${form.color === c ? "border-gray-900 scale-110" : "border-gray-300"}`}
                  style={{ backgroundColor: c }}
                  onClick={() => setForm((f) => ({ ...f, color: c }))}
                />
              ))}
            </div>
          </div>

          {/* Grid position — read-only from canvas, but editable for manual entry */}
          <div className="rounded border bg-muted/30 p-3 space-y-2">
            <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Grid Position</Label>
            <div className="grid grid-cols-4 gap-2">
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Col</p>
                <Input type="number" value={form.grid_col} onChange={set("grid_col")} min={1} max={floor?.grid_cols ?? 30} className="text-sm" />
              </div>
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Row</p>
                <Input type="number" value={form.grid_row} onChange={set("grid_row")} min={1} max={floor?.grid_rows ?? 20} className="text-sm" />
              </div>
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Width</p>
                <Input type="number" value={form.grid_col_span} onChange={set("grid_col_span")} min={1} max={floor?.grid_cols ?? 30} className="text-sm" />
              </div>
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Height</p>
                <Input type="number" value={form.grid_row_span} onChange={set("grid_row_span")} min={1} max={floor?.grid_rows ?? 20} className="text-sm" />
              </div>
            </div>
            {floor && (
              <p className="text-xs text-muted-foreground">
                Floor: {floor.name} ({floor.grid_cols}×{floor.grid_rows} grid)
              </p>
            )}
          </div>

          {/* Notes */}
          <div className="space-y-1">
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={set("notes")} placeholder="Any additional notes…" rows={2} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? "Saving…" : isEdit ? "Save Changes" : "Add Unit"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
