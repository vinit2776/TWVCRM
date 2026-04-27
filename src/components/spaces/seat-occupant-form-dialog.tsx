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
import { Loader2, ChevronRight, Check } from "lucide-react";
import { toast } from "sonner";
import type { SpaceSeatOccupant, SpaceUnit, ContractSpaceAllocation } from "@/types";

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
  defaultUnitId?: string;
  allocatedUnits: ContractSpaceAllocation[];
  occupant?: SpaceSeatOccupant | null;
  onSuccess: (occupant: SpaceSeatOccupant) => void;
}

type Step = "pick_unit" | "person_details";

export function SeatOccupantFormDialog({
  open, onOpenChange, contractId, defaultUnitId, allocatedUnits, occupant, onSuccess,
}: Props) {
  const isEdit = !!occupant;
  // When editing or only 1 unit, skip the unit picker step
  const skipUnitStep = isEdit || allocatedUnits.length <= 1;

  const [step, setStep] = useState<Step>(skipUnitStep ? "person_details" : "pick_unit");
  const [spaceUnitId, setSpaceUnitId] = useState(
    defaultUnitId || occupant?.space_unit_id || allocatedUnits[0]?.space_unit_id || ""
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [seatLabel, setSeatLabel] = useState("");
  const [startDate, setStartDate] = useState(new Date().toISOString().split("T")[0]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(skipUnitStep ? "person_details" : "pick_unit");
    setSpaceUnitId(defaultUnitId || occupant?.space_unit_id || allocatedUnits[0]?.space_unit_id || "");
    setName(occupant?.occupant_name || "");
    setEmail(occupant?.occupant_email || "");
    setPhone(occupant?.occupant_phone || "");
    setSeatLabel(occupant?.seat_label || "");
    setStartDate(occupant?.start_date || new Date().toISOString().split("T")[0]);
    setNotes(occupant?.notes || "");
  }, [open, occupant, defaultUnitId, allocatedUnits, skipUnitStep]);

  const selectedAlloc = allocatedUnits.find((a) => a.space_unit_id === spaceUnitId);
  const selectedUnit = selectedAlloc?.space_unit as SpaceUnit | undefined;

  // ── Step 1: Unit picker ──────────────────────────────────────────────────
  const StepPickUnit = () => (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Which space will this person occupy?
      </p>
      <div className="space-y-2">
        {allocatedUnits.map((a) => {
          const u = a.space_unit as SpaceUnit | undefined;
          if (!u) return null;
          const selected = spaceUnitId === a.space_unit_id;
          return (
            <button
              key={a.space_unit_id}
              type="button"
              onClick={() => setSpaceUnitId(a.space_unit_id)}
              className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                selected
                  ? "border-[#015E65] bg-[#015E65]/5"
                  : "border-border hover:bg-muted/40"
              }`}
            >
              <div className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 ${
                selected ? "bg-[#015E65] text-white" : "bg-muted text-muted-foreground"
              }`}>
                {selected ? <Check className="h-4 w-4" /> : <span className="text-xs font-mono">{u.code.slice(0, 2)}</span>}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono font-bold">{u.code}</code>
                  <span className="text-sm font-medium truncate">{u.name}</span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-4 ${TYPE_COLORS[u.type] || ""}`}>
                    {u.type.replace(/_/g, " ")}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{u.capacity} seat{u.capacity !== 1 ? "s" : ""}</span>
                </div>
              </div>
              <ChevronRight className={`h-4 w-4 shrink-0 ${selected ? "text-[#015E65]" : "text-muted-foreground"}`} />
            </button>
          );
        })}
      </div>
      <div className="flex justify-end pt-1">
        <Button
          type="button"
          disabled={!spaceUnitId}
          onClick={() => setStep("person_details")}
        >
          Next: Person Details
          <ChevronRight className="ml-1.5 h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  // ── Step 2: Person details ───────────────────────────────────────────────
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { toast.error("Name is required"); return; }

    setSaving(true);
    try {
      let res: Response;
      if (isEdit) {
        res = await fetch(`/api/contracts/${contractId}/seat-occupants/${occupant!.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            occupant_name: name.trim(),
            occupant_email: email.trim() || null,
            occupant_phone: phone.trim() || null,
            seat_label: seatLabel.trim() || null,
            start_date: startDate,
            notes: notes.trim() || null,
          }),
        });
      } else {
        res = await fetch(`/api/contracts/${contractId}/seat-occupants`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            space_unit_id: spaceUnitId,
            occupant_name: name.trim(),
            occupant_email: email.trim() || null,
            occupant_phone: phone.trim() || null,
            seat_label: seatLabel.trim() || null,
            start_date: startDate,
            notes: notes.trim() || null,
          }),
        });
      }
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Failed to save"); return; }
      toast.success(isEdit ? "Person updated" : "Person added to seat");
      onSuccess(json.data);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  const StepPersonDetails = () => (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Context: which unit */}
      {selectedUnit && !isEdit && (
        <div className="rounded-md bg-muted/40 border px-3 py-2 flex items-center gap-2 text-sm">
          <code className="font-mono text-xs bg-background border px-1.5 py-0.5 rounded">{selectedUnit.code}</code>
          <span className="text-muted-foreground">{selectedUnit.name}</span>
          {!skipUnitStep && (
            <button
              type="button"
              className="ml-auto text-xs text-[#015E65] hover:underline"
              onClick={() => setStep("pick_unit")}
            >
              Change
            </button>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="occ-name">
          What is this person&apos;s name? <span className="text-destructive">*</span>
        </Label>
        <Input
          id="occ-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Rahul Sharma"
          autoFocus
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="occ-email">Email address</Label>
          <Input
            id="occ-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="rahul@company.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="occ-phone">Phone</Label>
          <Input
            id="occ-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91 98765 43210"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="occ-seat">Specific seat / desk label <span className="text-xs text-muted-foreground">(optional)</span></Label>
          <Input
            id="occ-seat"
            value={seatLabel}
            onChange={(e) => setSeatLabel(e.target.value)}
            placeholder="e.g. A1, Desk 3"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="occ-start">Joining date</Label>
          <Input
            id="occ-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="occ-notes">Any notes? <span className="text-xs text-muted-foreground">(optional)</span></Label>
        <Textarea
          id="occ-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Works in the morning shift only…"
          rows={2}
        />
      </div>

      <div className="flex justify-between pt-1">
        {!skipUnitStep ? (
          <Button type="button" variant="ghost" onClick={() => setStep("pick_unit")}>
            ← Back
          </Button>
        ) : <div />}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isEdit ? "Save Changes" : "Add Person"}
          </Button>
        </div>
      </div>
    </form>
  );

  // Wizard step indicator
  const stepLabel = isEdit
    ? "Edit Person"
    : step === "pick_unit"
      ? "Step 1 of 2 — Select Space"
      : `Step ${skipUnitStep ? "1" : "2"} of ${skipUnitStep ? "1" : "2"} — Person Details`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Person Details" : "Add Person to Seat"}</DialogTitle>
          {!isEdit && (
            <p className="text-xs text-muted-foreground mt-0.5">{stepLabel}</p>
          )}
        </DialogHeader>
        <div className="mt-2">
          {step === "pick_unit" ? <StepPickUnit /> : <StepPersonDetails />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
