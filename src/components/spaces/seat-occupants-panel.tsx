"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  UserPlus, Pencil, ArrowRightLeft, UserX, Loader2, ChevronDown, ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { SeatOccupantFormDialog } from "./seat-occupant-form-dialog";
import { SeatTransferDialog } from "./seat-transfer-dialog";
import type { SpaceSeatOccupant, ContractSpaceAllocation } from "@/types";

const TYPE_COLORS: Record<string, string> = {
  hot_desk:        "bg-sky-100 text-sky-700 border-sky-200",
  dedicated_desk:  "bg-blue-100 text-blue-700 border-blue-200",
  private_cabin:   "bg-violet-100 text-violet-700 border-violet-200",
  managed_office:  "bg-pink-100 text-pink-700 border-pink-200",
  business_centre: "bg-amber-100 text-amber-700 border-amber-200",
};

interface Props {
  contractId: string;
  locationId: string;
  allocations: ContractSpaceAllocation[];
}

export function SeatOccupantsPanel({ contractId, locationId, allocations }: Props) {
  const [occupants, setOccupants] = useState<SpaceSeatOccupant[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedUnitIds, setExpandedUnitIds] = useState<Set<string>>(new Set());

  // Dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [defaultUnitId, setDefaultUnitId] = useState<string | undefined>();
  const [editOccupant, setEditOccupant] = useState<SpaceSeatOccupant | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [transferOccupant, setTransferOccupant] = useState<SpaceSeatOccupant | null>(null);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const fetchOccupants = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/contracts/${contractId}/seat-occupants?status=active`);
    if (res.ok) {
      const json = await res.json();
      setOccupants(json.data || []);
    }
    setLoading(false);
  }, [contractId]);

  useEffect(() => { fetchOccupants(); }, [fetchOccupants]);

  // Auto-expand units that have occupants
  useEffect(() => {
    if (occupants.length > 0) {
      setExpandedUnitIds(new Set(occupants.map((o) => o.space_unit_id)));
    }
  }, [occupants]);

  const toggleUnit = (unitId: string) => {
    setExpandedUnitIds((prev) => {
      const next = new Set(prev);
      next.has(unitId) ? next.delete(unitId) : next.add(unitId);
      return next;
    });
  };

  const handleAddPerson = (unitId?: string) => {
    setDefaultUnitId(unitId);
    setAddDialogOpen(true);
  };

  const handleAddSuccess = (occ: SpaceSeatOccupant) => {
    setOccupants((prev) => [...prev, occ]);
    setExpandedUnitIds((prev) => new Set([...prev, occ.space_unit_id]));
  };

  const handleEditSuccess = (updated: SpaceSeatOccupant) => {
    setOccupants((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
  };

  const handleTransferSuccess = (old: SpaceSeatOccupant, next: SpaceSeatOccupant) => {
    // Remove old (it's now 'transferred'), add new if it's for the same contract
    setOccupants((prev) => {
      const without = prev.filter((o) => o.id !== old.id);
      if (next.contract_id === contractId) return [...without, next];
      return without;
    });
    if (next.contract_id !== contractId) {
      toast.info(`${old.occupant_name} moved to a different contract's unit.`);
    }
  };

  const handleRemove = async (occ: SpaceSeatOccupant) => {
    if (!window.confirm(`End ${occ.occupant_name}'s seat assignment?`)) return;
    setRemovingId(occ.id);
    const res = await fetch(
      `/api/contracts/${contractId}/seat-occupants/${occ.id}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      setOccupants((prev) => prev.filter((o) => o.id !== occ.id));
      toast.success("Seat assignment ended");
    } else {
      const json = await res.json().catch(() => null);
      toast.error(json?.error || "Failed to remove");
    }
    setRemovingId(null);
  };

  if (allocations.length === 0) return null;

  const totalOccupants = occupants.length;
  const totalCapacity = allocations.reduce((s, a) => s + (a.space_unit?.capacity ?? 0), 0);

  return (
    <div className="space-y-2 mt-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold">Seat Occupants</h4>
          {!loading && (
            <span className="text-xs text-muted-foreground">
              {totalOccupants} / {totalCapacity} seat{totalCapacity !== 1 ? "s" : ""} filled
            </span>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={() => handleAddPerson(allocations.length === 1 ? allocations[0].space_unit_id : undefined)}
        >
          <UserPlus className="h-3 w-3" />
          Add Person
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="h-3 w-3 animate-spin" />Loading occupants…
        </div>
      ) : (
        <div className="space-y-2">
          {allocations.map((alloc) => {
            const unit = alloc.space_unit;
            if (!unit) return null;
            const unitOccupants = occupants.filter((o) => o.space_unit_id === unit.id);
            const isExpanded = expandedUnitIds.has(unit.id);
            const typeColor = TYPE_COLORS[unit.type] || "";

            return (
              <div key={alloc.id} className="rounded-md border overflow-hidden">
                {/* Unit row — clickable to expand/collapse */}
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 text-left bg-muted/20 hover:bg-muted/40 transition-colors"
                  onClick={() => toggleUnit(unit.id)}
                >
                  {isExpanded
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  }
                  <code className="text-[10px] font-mono bg-background border px-1 py-0.5 rounded">{unit.code}</code>
                  <span className="text-xs font-medium flex-1 truncate">{unit.name}</span>
                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-4 leading-none ${typeColor}`}>
                    {unit.type.replace(/_/g, " ")}
                  </Badge>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {unitOccupants.length}/{unit.capacity}
                  </span>
                </button>

                {isExpanded && (
                  <div className="divide-y">
                    {unitOccupants.length === 0 ? (
                      <p className="px-3 py-2.5 text-xs text-muted-foreground italic">
                        No people assigned to this unit yet.
                      </p>
                    ) : (
                      unitOccupants.map((occ) => (
                        <div
                          key={occ.id}
                          className="flex items-center gap-3 px-3 py-2.5 bg-background"
                        >
                          {/* Avatar circle */}
                          <div className="h-7 w-7 rounded-full bg-[#015E65]/10 text-[#015E65] flex items-center justify-center text-xs font-bold shrink-0">
                            {occ.occupant_name.charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-sm font-medium truncate">{occ.occupant_name}</span>
                              {occ.seat_label && (
                                <code className="text-[10px] font-mono bg-muted px-1 py-0.5 rounded text-muted-foreground">
                                  {occ.seat_label}
                                </code>
                              )}
                            </div>
                            <p className="text-[11px] text-muted-foreground truncate">
                              {[occ.occupant_email, occ.occupant_phone].filter(Boolean).join(" · ") || "No contact info"}
                            </p>
                          </div>
                          {/* Actions */}
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-muted-foreground hover:text-foreground"
                              title="Edit"
                              onClick={() => { setEditOccupant(occ); setEditDialogOpen(true); }}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-muted-foreground hover:text-[#015E65]"
                              title="Transfer / Shift"
                              onClick={() => { setTransferOccupant(occ); setTransferDialogOpen(true); }}
                            >
                              <ArrowRightLeft className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-muted-foreground hover:text-destructive"
                              title="End assignment"
                              disabled={removingId === occ.id}
                              onClick={() => handleRemove(occ)}
                            >
                              {removingId === occ.id
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <UserX className="h-3 w-3" />
                              }
                            </Button>
                          </div>
                        </div>
                      ))
                    )}
                    {/* Per-unit Add button */}
                    <div className="px-3 py-2 bg-muted/10">
                      <button
                        type="button"
                        className="text-xs text-[#015E65] hover:underline flex items-center gap-1"
                        onClick={() => handleAddPerson(unit.id)}
                      >
                        <UserPlus className="h-3 w-3" />
                        Add person to {unit.code}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Dialogs */}
      <SeatOccupantFormDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        contractId={contractId}
        defaultUnitId={defaultUnitId}
        allocatedUnits={allocations}
        onSuccess={handleAddSuccess}
      />
      {editOccupant && (
        <SeatOccupantFormDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          contractId={contractId}
          allocatedUnits={allocations}
          occupant={editOccupant}
          onSuccess={handleEditSuccess}
        />
      )}
      {transferOccupant && (
        <SeatTransferDialog
          open={transferDialogOpen}
          onOpenChange={setTransferDialogOpen}
          contractId={contractId}
          occupant={transferOccupant}
          locationId={locationId}
          onSuccess={handleTransferSuccess}
        />
      )}
    </div>
  );
}
