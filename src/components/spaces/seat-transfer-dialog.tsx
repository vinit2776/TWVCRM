"use client";

import { useState, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, ArrowRight, ChevronRight, Check, MapPin } from "lucide-react";
import { toast } from "sonner";
import type { SpaceSeatOccupant, SpaceUnit } from "@/types";

const TYPE_COLORS: Record<string, string> = {
  hot_desk:        "bg-sky-100 text-sky-700 border-sky-200",
  dedicated_desk:  "bg-blue-100 text-blue-700 border-blue-200",
  private_cabin:   "bg-violet-100 text-violet-700 border-violet-200",
  managed_office:  "bg-pink-100 text-pink-700 border-pink-200",
  business_centre: "bg-amber-100 text-amber-700 border-amber-200",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contractId: string;
  occupant: SpaceSeatOccupant;
  locationId: string;
  onSuccess: (oldOccupant: SpaceSeatOccupant, newOccupant: SpaceSeatOccupant) => void;
}

type Step = "pick_target" | "confirm_details";

export function SeatTransferDialog({ open, onOpenChange, contractId, occupant, locationId, onSuccess }: Props) {
  const [step, setStep] = useState<Step>("pick_target");
  const [availableUnits, setAvailableUnits] = useState<SpaceUnit[]>([]);
  const [loadingUnits, setLoadingUnits] = useState(false);
  const [targetUnitId, setTargetUnitId] = useState("");
  const [transferDate, setTransferDate] = useState(new Date().toISOString().split("T")[0]);
  const [seatLabel, setSeatLabel] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !locationId) return;
    setStep("pick_target");
    setTargetUnitId(""); setSeatLabel(""); setNotes("");
    setTransferDate(new Date().toISOString().split("T")[0]);
    setLoadingUnits(true);
    fetch(`/api/locations/${locationId}/space-units?is_active=true`)
      .then((r) => r.json())
      .then((json) => {
        const units: SpaceUnit[] = (json.data || []).filter(
          (u: SpaceUnit) => u.id !== occupant.space_unit_id
        );
        setAvailableUnits(units);
      })
      .catch(() => setAvailableUnits([]))
      .finally(() => setLoadingUnits(false));
  }, [open, locationId, occupant.space_unit_id]);

  const currentUnit = occupant.space_unit;
  const targetUnit = availableUnits.find((u) => u.id === targetUnitId);

  // Group by floor
  const byFloor = availableUnits.reduce<Record<string, { name: string; units: SpaceUnit[] }>>((acc, u) => {
    const key = u.floor_id ?? "__nofloor__";
    const label = (u as SpaceUnit & { floor?: { name: string } }).floor?.name ?? "No Floor Assigned";
    if (!acc[key]) acc[key] = { name: label, units: [] };
    acc[key].units.push(u);
    return acc;
  }, {});

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/contracts/${contractId}/seat-occupants/${occupant.id}/transfer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            new_space_unit_id: targetUnitId,
            transfer_date: transferDate,
            seat_label: seatLabel.trim() || null,
            notes: notes.trim() || null,
          }),
        }
      );
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Transfer failed"); return; }
      toast.success(`${occupant.occupant_name} moved to ${targetUnit?.name}`);
      onSuccess(json.old as SpaceSeatOccupant, json.new as SpaceSeatOccupant);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  // ── Step 1: Pick new unit ────────────────────────────────────────────────
  const StepPickTarget = () => (
    <div className="space-y-4">
      {/* Who is moving */}
      <div className="rounded-lg bg-muted/40 border p-3 space-y-1">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Moving</p>
        <p className="font-semibold">{occupant.occupant_name}</p>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <MapPin className="h-3.5 w-3.5 shrink-0" />
          <span>Currently at</span>
          <code className="font-mono text-xs bg-background border px-1.5 py-0.5 rounded">{currentUnit?.code}</code>
          <span className="truncate">{currentUnit?.name}</span>
        </div>
      </div>

      <div>
        <p className="text-sm font-medium mb-2">Where should they move to?</p>
        {loadingUnits ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" />Loading available spaces…
          </div>
        ) : availableUnits.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No other active spaces at this location to move to.
          </div>
        ) : (
          <div className="space-y-3 max-h-64 overflow-y-auto">
            {Object.entries(byFloor).map(([, { name: floorName, units }]) => (
              <div key={floorName}>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
                  <MapPin className="h-3 w-3" />
                  {floorName}
                </p>
                <div className="space-y-1.5">
                  {units.map((u) => {
                    const selected = targetUnitId === u.id;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const activeOccupants = (u as any).active_allocations?.length ?? 0;
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => setTargetUnitId(u.id)}
                        className={`w-full flex items-center gap-3 p-2.5 rounded-lg border text-left transition-colors ${
                          selected
                            ? "border-[#015E65] bg-[#015E65]/5"
                            : "border-border hover:bg-muted/40"
                        }`}
                      >
                        <div className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 text-xs ${
                          selected ? "bg-[#015E65] text-white" : "bg-muted text-muted-foreground font-mono"
                        }`}>
                          {selected ? <Check className="h-4 w-4" /> : u.code.slice(0, 2)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <code className="text-xs font-mono font-bold">{u.code}</code>
                            <span className="text-sm truncate">{u.name}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-4 ${TYPE_COLORS[u.type] || ""}`}>
                              {u.type.replace(/_/g, " ")}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {u.capacity} seat{u.capacity !== 1 ? "s" : ""}
                              {activeOccupants > 0 && ` · ${activeOccupants} occupied`}
                            </span>
                          </div>
                        </div>
                        <ChevronRight className={`h-4 w-4 shrink-0 ${selected ? "text-[#015E65]" : "text-muted-foreground"}`} />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex justify-end pt-1">
        <Button
          type="button"
          disabled={!targetUnitId}
          onClick={() => setStep("confirm_details")}
        >
          Next: Set Date &amp; Reason
          <ChevronRight className="ml-1.5 h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  // ── Step 2: Date, seat label, reason + confirmation summary ─────────────
  const StepConfirmDetails = () => (
    <div className="space-y-4">
      {/* Transfer summary */}
      <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
        <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Transfer Summary</p>
        <div className="flex items-center gap-2 text-sm">
          <div className="flex-1 min-w-0">
            <p className="font-semibold">{occupant.occupant_name}</p>
            <p className="text-xs text-muted-foreground">{currentUnit?.name} ({currentUnit?.code})</p>
          </div>
          <ArrowRight className="h-5 w-5 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0 text-right">
            <p className="font-semibold text-[#015E65]">{targetUnit?.name}</p>
            <p className="text-xs text-muted-foreground">{targetUnit?.code}</p>
          </div>
        </div>
        <button
          type="button"
          className="text-xs text-[#015E65] hover:underline"
          onClick={() => setStep("pick_target")}
        >
          ← Change target unit
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Effective from</Label>
          <Input
            type="date"
            value={transferDate}
            onChange={(e) => setTransferDate(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label>New seat / desk label <span className="text-xs text-muted-foreground">(optional)</span></Label>
          <Input
            value={seatLabel}
            onChange={(e) => setSeatLabel(e.target.value)}
            placeholder="e.g. B4, Desk 7"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Reason for shift <span className="text-xs text-muted-foreground">(optional)</span></Label>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Cabin upgrade, team restructuring, client preference…"
          rows={2}
        />
      </div>

      <div className="flex justify-between pt-1">
        <Button type="button" variant="ghost" onClick={() => setStep("pick_target")}>
          ← Back
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Confirm Transfer
          </Button>
        </div>
      </div>
    </div>
  );

  const stepLabel = step === "pick_target" ? "Step 1 of 2 — Choose Destination" : "Step 2 of 2 — Confirm Details";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Shift Person to New Space</DialogTitle>
          <p className="text-xs text-muted-foreground mt-0.5">{stepLabel}</p>
        </DialogHeader>
        <div className="mt-2">
          {step === "pick_target" ? <StepPickTarget /> : <StepConfirmDetails />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
