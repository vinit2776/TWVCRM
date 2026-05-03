"use client";

/**
 * SpaceUnitFormDialog
 *
 * ADD mode (no `unit` prop):
 *   2-step wizard:
 *     Step 1 — Pick type (visual cards)
 *     Step 2 — Details (name, code, seats stepper, rate, area) + live block-size preview against floor grid
 *   On "Place on Canvas" → calls onReadyToPlace(data) — NO API call yet.
 *   The canvas then handles positioning via click-to-place.
 *
 * EDIT mode (`unit` prop present):
 *   Compact form → PUT API call → calls onSuccess(updated).
 */

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ChevronRight, Minus, Plus, Check, Loader2 } from "lucide-react";
import type { SpaceUnit, SpaceUnitType, LocationFloor } from "@/types";

// ── Constants ──────────────────────────────────────────────────────────────

const COLOR_MAP: Record<SpaceUnitType, string> = {
  hot_desk:        "#e0f2fe",
  dedicated_desk:  "#bfdbfe",
  private_cabin:   "#ede9fe",
  managed_office:  "#fce7f3",
  business_centre: "#fef3c7",
};
const BORDER_MAP: Record<SpaceUnitType, string> = {
  hot_desk:        "#7dd3fc",
  dedicated_desk:  "#93c5fd",
  private_cabin:   "#c4b5fd",
  managed_office:  "#f9a8d4",
  business_centre: "#fcd34d",
};

const TYPE_META: {
  value: SpaceUnitType;
  label: string;
  emoji: string;
  description: string;
  seatRange: string;
  isHourly: boolean;
}[] = [
  {
    value: "hot_desk", label: "Hot Desk", emoji: "🪑",
    description: "Open, flexible seating. Booked daily or shared.",
    seatRange: "1 – 20+ seats", isHourly: false,
  },
  {
    value: "dedicated_desk", label: "Dedicated Desk", emoji: "🖥️",
    description: "Fixed, named desks. Reserved for one person.",
    seatRange: "1 – 10 seats", isHourly: false,
  },
  {
    value: "private_cabin", label: "Private Cabin", emoji: "🚪",
    description: "Enclosed private office for small teams.",
    seatRange: "1 – 6 seats", isHourly: false,
  },
  {
    value: "managed_office", label: "Managed Office", emoji: "🏢",
    description: "Fully managed suite for larger teams.",
    seatRange: "5 – 50+ seats", isHourly: false,
  },
  {
    value: "business_centre", label: "Business Centre", emoji: "⏱️",
    description: "Pay-per-hour, walk-in, or meeting use.",
    seatRange: "1 – 8 seats", isHourly: true,
  },
];

const AMENITIES_OPTIONS = [
  "AC", "Whiteboard", "TV / Screen", "Phone",
  "Storage", "Standing Desk", "Natural Light", "Soundproofing",
];

// ── Size suggestion ─────────────────────────────────────────────────────────

export function suggestBlockSize(type: SpaceUnitType, capacity: number): { cols: number; rows: number } {
  switch (type) {
    case "hot_desk":
      if (capacity <= 1) return { cols: 2, rows: 2 };
      if (capacity <= 4) return { cols: 4, rows: 2 };
      if (capacity <= 8) return { cols: 5, rows: 2 };
      return { cols: 6, rows: 3 };
    case "dedicated_desk":
      if (capacity <= 1) return { cols: 2, rows: 2 };
      if (capacity <= 3) return { cols: 3, rows: 2 };
      if (capacity <= 6) return { cols: 4, rows: 3 };
      return { cols: 5, rows: 3 };
    case "private_cabin":
      if (capacity <= 2) return { cols: 3, rows: 3 };
      if (capacity <= 4) return { cols: 4, rows: 3 };
      return { cols: 5, rows: 4 };
    case "managed_office":
      if (capacity <= 8)  return { cols: 5, rows: 4 };
      if (capacity <= 15) return { cols: 7, rows: 4 };
      return { cols: 8, rows: 5 };
    case "business_centre":
      return { cols: 4, rows: 3 };
    default:
      return { cols: 2, rows: 2 };
  }
}

function suggestCode(type: SpaceUnitType, existingUnits: SpaceUnit[]): string {
  const prefixes: Record<SpaceUnitType, string> = {
    hot_desk: "HD", dedicated_desk: "DD", private_cabin: "CB",
    managed_office: "MO", business_centre: "BC",
  };
  const n = existingUnits.filter((u) => u.type === type).length + 1;
  return `${prefixes[type]}-${String(n).padStart(2, "0")}`;
}

function suggestName(type: SpaceUnitType, existingUnits: SpaceUnit[]): string {
  const n = existingUnits.filter((u) => u.type === type).length + 1;
  const p = String(n).padStart(2, "0");
  switch (type) {
    case "hot_desk":        return `Hot Desk ${p}`;
    case "dedicated_desk":  return `Dedicated Desk ${p}`;
    case "private_cabin":   return `Cabin ${p}`;
    case "managed_office":  return `Office Suite ${p}`;
    case "business_centre": return `Business Centre ${p}`;
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Shape of a unit-in-progress before it's placed on the canvas. Used by
 * floor-canvas.tsx to render the ghost block during click-to-place. Kept
 * here so both files have a single source of truth for what makes up a
 * pending unit (code/name + canvas footprint + colour hint).
 */
export interface PendingSpaceUnit {
  type: SpaceUnitType;
  code: string;
  name: string;
  grid_col_span: number;
  grid_row_span: number;
  color?: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locationId: string;
  floor: LocationFloor | null;
  /** Existing units on this floor — used for code/name auto-suggestion */
  existingUnits: SpaceUnit[];
  /** Edit mode — present when editing an existing unit */
  unit?: SpaceUnit | null;
  /** Called after unit is saved (add or edit) */
  onSuccess?: (unit: SpaceUnit) => void;
  /** Called when user deletes a unit from the edit dialog */
  onDelete?: (unit: SpaceUnit) => void;
}

// ── Stepper ─────────────────────────────────────────────────────────────────

function Stepper({ value, onChange, min = 1, max = 100 }: {
  value: number; onChange: (n: number) => void; min?: number; max?: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        className="h-8 w-8 rounded border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="w-10 text-center font-semibold tabular-nums">{value}</span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        className="h-8 w-8 rounded border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function SpaceUnitFormDialog({
  open, onOpenChange, locationId, floor, existingUnits, unit, onSuccess, onDelete,
}: Props) {
  const isEdit = !!unit;

  // Wizard state (add mode)
  const [step, setStep] = useState<"type" | "details">("type");
  const [type, setType] = useState<SpaceUnitType>("private_cabin");

  // Form fields
  const [name, setName]         = useState("");
  const [code, setCode]         = useState("");
  const [capacity, setCapacity] = useState(2);
  const [rate, setRate]         = useState("");
  const [dailyRate, setDailyRate] = useState("");
  const [areaSqft, setAreaSqft] = useState("");
  const [notes, setNotes]       = useState("");
  const [amenities, setAmenities] = useState<string[]>([]);
  const [colSpan, setColSpan]   = useState(3);
  const [rowSpan, setRowSpan]   = useState(3);

  // Edit loading
  const [saving, setSaving] = useState(false);

  const isHourly = type === "business_centre";

  // Auto-size when type or capacity changes (add mode only)
  useEffect(() => {
    if (isEdit) return;
    const s = suggestBlockSize(type, capacity);
    setColSpan(s.cols);
    setRowSpan(s.rows);
  }, [type, capacity, isEdit]);

  // Reset on open
  useEffect(() => {
    if (!open) return;
    if (unit) {
      // Edit mode — prefill from unit
      setType(unit.type);
      setName(unit.name);
      setCode(unit.code);
      setCapacity(unit.capacity);
      setRate(String(unit.monthly_rate ?? unit.hourly_rate ?? ""));
      setDailyRate(String(unit.daily_rate ?? ""));
      setAreaSqft(String(unit.area_sqft ?? ""));
      setNotes(unit.notes ?? "");
      setAmenities(unit.amenities ?? []);
      setColSpan(unit.grid_col_span);
      setRowSpan(unit.grid_row_span);
    } else {
      // Add mode — smart defaults
      const defaultType: SpaceUnitType = "private_cabin";
      setStep("type");
      setType(defaultType);
      setCapacity(2);
      setName(suggestName(defaultType, existingUnits));
      setCode(suggestCode(defaultType, existingUnits));
      setRate(""); setDailyRate(""); setAreaSqft(""); setNotes("");
      setAmenities([]);
      const s = suggestBlockSize(defaultType, 2);
      setColSpan(s.cols); setRowSpan(s.rows);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, unit]);

  // When type changes in add wizard, re-suggest name+code
  const handleTypeSelect = (t: SpaceUnitType) => {
    setType(t);
    const defaultCap = t === "managed_office" ? 8 : t === "business_centre" ? 1 : 2;
    setCapacity(defaultCap);
    setName(suggestName(t, existingUnits));
    setCode(suggestCode(t, existingUnits));
    const s = suggestBlockSize(t, defaultCap);
    setColSpan(s.cols); setRowSpan(s.rows);
    setStep("details");
  };

  // ── Add mode: save directly ──────────────────────────────────────────────
  // Rates are intentionally NOT collected here — the price a customer pays
  // is set on the contract, not on the floor-plan unit. We store null and
  // let admin fill it in later from Edit Unit if they want it for reports.
  const handleAddSubmit = async () => {
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (!code.trim()) { toast.error("Code is required"); return; }
    if (!floor) { toast.error("No floor selected"); return; }

    const rateVal = rate.trim() === "" ? null : parseFloat(rate);
    const dailyRateVal = dailyRate.trim() === "" ? null : parseFloat(dailyRate);

    setSaving(true);
    try {
      const res = await fetch(`/api/locations/${locationId}/space-units`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          floor_id: floor.id,
          type,
          name: name.trim(),
          code: code.trim().toUpperCase(),
          capacity,
          area_sqft: areaSqft ? Number(areaSqft) : null,
          monthly_rate: isHourly ? null : rateVal,
          daily_rate: dailyRateVal,
          hourly_rate: isHourly ? rateVal : null,
          amenities,
          notes: notes.trim(),
          color: COLOR_MAP[type],
          grid_col_span: colSpan,
          grid_row_span: rowSpan,
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to add unit"); return; }
      toast.success(`${name.trim()} added`);
      onSuccess?.(json.data);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  // ── Edit mode: submit ─────────────────────────────────────────────────────
  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unit) return;
    if (!name.trim()) { toast.error("Name is required"); return; }

    // Rate optional in edit too — admin can clear it if it was set in error.
    const rateVal = rate.trim() === "" ? null : parseFloat(rate);
    const dailyRateVal = dailyRate.trim() === "" ? null : parseFloat(dailyRate);

    setSaving(true);
    try {
      const res = await fetch(`/api/locations/${locationId}/space-units/${unit.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          code: code.trim().toUpperCase(),
          type,
          capacity,
          area_sqft: areaSqft ? Number(areaSqft) : null,
          monthly_rate: isHourly ? null : rateVal,
          daily_rate: dailyRateVal,
          hourly_rate: isHourly ? rateVal : null,
          amenities,
          notes: notes.trim(),
          grid_col_span: colSpan,
          grid_row_span: rowSpan,
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to update"); return; }
      toast.success("Space unit updated");
      onSuccess?.(json.data);
      onOpenChange(false);
    } finally { setSaving(false); }
  };

  // ── Render: Step 1 — Type selection ──────────────────────────────────────
  const StepType = () => (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Select the type of space you want to add to this floor.
      </p>
      <div className="space-y-2">
        {TYPE_META.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => handleTypeSelect(t.value)}
            className="w-full flex items-center gap-3 p-3 rounded-lg border text-left hover:bg-muted/40 hover:border-[#015E65]/40 transition-all group"
          >
            {/* Color swatch + emoji */}
            <div
              className="h-10 w-10 rounded-md flex items-center justify-center text-xl shrink-0"
              style={{ backgroundColor: COLOR_MAP[t.value], border: `1.5px solid ${BORDER_MAP[t.value]}` }}
            >
              {t.emoji}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm">{t.label}</span>
                {t.isHourly && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">Hourly</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">{t.description}</p>
              <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t.seatRange}</p>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 group-hover:text-[#015E65]" />
          </button>
        ))}
      </div>
    </div>
  );

  // ── Render: Step 2 — Details + preview ───────────────────────────────────
  const selectedMeta = TYPE_META.find((t) => t.value === type)!;

  const StepDetails = () => (
    <div className="space-y-4">
      {/* Type chip — click to go back */}
      <button
        type="button"
        onClick={() => setStep("type")}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground group"
      >
        <div
          className="h-7 w-7 rounded-md flex items-center justify-center text-base"
          style={{ backgroundColor: COLOR_MAP[type], border: `1.5px solid ${BORDER_MAP[type]}` }}
        >
          {selectedMeta.emoji}
        </div>
        <span className="font-medium">{selectedMeta.label}</span>
        <span className="text-xs text-[#015E65] group-hover:underline">Change type</span>
      </button>

      {/* Name + Code */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="su-name">Name <span className="text-destructive">*</span></Label>
          <Input
            id="su-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`e.g. ${suggestName(type, existingUnits)}`}
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="su-code">Code <span className="text-destructive">*</span></Label>
          <Input
            id="su-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={`e.g. ${suggestCode(type, existingUnits)}`}
            className="font-mono"
          />
        </div>
      </div>

      {/* Seats */}
      <div className="space-y-1.5">
        <Label>How many seats?</Label>
        <div className="flex items-center gap-4">
          <Stepper value={capacity} onChange={setCapacity} min={1} max={100} />
          <span className="text-sm text-muted-foreground">
            seat{capacity !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* Area (sqft) — rate intentionally NOT collected here. Pricing is set
          on the contract drawn against this unit, so capturing it twice causes
          drift. Admin can still set rates from Edit Unit if needed for reports. */}
      <div className="space-y-1.5">
        <Label htmlFor="su-area">Area (sqft) <span className="text-xs text-muted-foreground">(optional)</span></Label>
        <Input
          id="su-area"
          type="number"
          value={areaSqft}
          onChange={(e) => setAreaSqft(e.target.value)}
          placeholder="e.g. 180"
          min={0}
        />
      </div>

      {/* Notes */}
      <div className="space-y-1.5">
        <Label htmlFor="su-notes">Notes <span className="text-xs text-muted-foreground">(optional)</span></Label>
        <Textarea
          id="su-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Any extra info about this space…"
          rows={2}
        />
      </div>

      {/* Amenities — collapsible */}
      <details className="group">
        <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground select-none">
          ▸ Amenities (optional)
        </summary>
        <div className="grid grid-cols-2 gap-2 mt-2">
          {AMENITIES_OPTIONS.map((a) => (
            <div key={a} className="flex items-center gap-2">
              <Checkbox
                id={`am-${a}`}
                checked={amenities.includes(a)}
                onCheckedChange={() =>
                  setAmenities((prev) =>
                    prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]
                  )
                }
              />
              <label htmlFor={`am-${a}`} className="text-sm cursor-pointer">{a}</label>
            </div>
          ))}
        </div>
      </details>

      {/* Actions */}
      <div className="flex items-center justify-between pt-1">
        <Button type="button" variant="ghost" onClick={() => setStep("type")}>
          ← Back
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleAddSubmit}
            disabled={saving}
            className="gap-1.5"
            style={{ backgroundColor: "#015E65", color: "white" }}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Add Unit
          </Button>
        </div>
      </div>
    </div>
  );

  // ── Edit mode render ──────────────────────────────────────────────────────
  const EditForm = () => (
    <form onSubmit={handleEditSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Name *</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label>Code *</Label>
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="font-mono" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Seats</Label>
          <Stepper value={capacity} onChange={setCapacity} min={1} max={100} />
        </div>
        <div className="space-y-1.5">
          <Label>Area (sqft) <span className="text-xs text-muted-foreground">(optional)</span></Label>
          <Input type="number" value={areaSqft} onChange={(e) => setAreaSqft(e.target.value)} />
        </div>
      </div>

      {/* Rates are optional — the contract sets the price the customer actually
          pays. Filled in here only if useful for inventory / reporting. */}
      <details className="group rounded-md border bg-muted/20 p-2">
        <summary className="cursor-pointer text-xs text-muted-foreground select-none">
          Rates <span className="opacity-60">(optional)</span>
        </summary>
        <div className="grid grid-cols-2 gap-3 mt-2">
          <div className="space-y-1.5">
            <Label>{isHourly ? "Hourly Rate (₹)" : "Monthly Rate (₹)"}</Label>
            <Input type="number" value={rate} onChange={(e) => setRate(e.target.value)} min={0} />
          </div>
          <div className="space-y-1.5">
            <Label>Daily Rate (₹)</Label>
            <Input type="number" value={dailyRate} onChange={(e) => setDailyRate(e.target.value)} />
          </div>
        </div>
      </details>

      <div className="space-y-1.5">
        <Label>Notes</Label>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </div>

      <div className="flex items-center justify-between pt-1">
        {onDelete && unit && (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive text-sm"
            onClick={() => { onDelete(unit!); onOpenChange(false); }}
          >
            Remove Unit
          </Button>
        )}
        <div className="flex gap-2 ml-auto">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}
            Save Changes
          </Button>
        </div>
      </div>
    </form>
  );

  // ── Dialog shell ──────────────────────────────────────────────────────────
  const title = isEdit ? `Edit — ${unit?.name}` : step === "type" ? "What type of space?" : "Space Details";
  const subtitle = isEdit ? null : step === "type" ? "Step 1 of 2" : "Step 2 of 2";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </DialogHeader>
        <div className="mt-2">
          {isEdit ? <EditForm /> : step === "type" ? <StepType /> : <StepDetails />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
