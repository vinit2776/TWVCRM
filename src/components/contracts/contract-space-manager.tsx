"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash2,
  Loader2,
  LayoutGrid,
  Lock,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import type { ContractSpaceAllocation, SpaceUnitType } from "@/types";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const TYPE_LABELS: Record<SpaceUnitType, string> = {
  hot_desk: "Hot Desk",
  dedicated_desk: "Dedicated Desk",
  private_cabin: "Private Cabin",
  managed_office: "Managed Office",
  business_centre: "Business Centre",
};

const TYPE_COLORS: Record<SpaceUnitType, string> = {
  hot_desk: "bg-sky-100 text-sky-700",
  dedicated_desk: "bg-blue-100 text-blue-700",
  private_cabin: "bg-violet-100 text-violet-700",
  managed_office: "bg-pink-100 text-pink-700",
  business_centre: "bg-amber-100 text-amber-700",
};

interface AvailableUnit {
  id: string;
  name: string;
  code: string;
  type: SpaceUnitType;
  capacity: number;
  monthly_rate: number | null;
  floor?: { id: string; name: string; floor_number: number | null } | null;
  active_allocations?: {
    id: string;
    status: string;
    contract?: {
      id: string;
      contract_number: string;
      status: string;
      seats?: number;
    } | null;
  }[];
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface Props {
  contractId: string;
  locationId: string | null;
  contractSeats: number;
  contractStatus: string;
  contractStartDate: string;
  contractEndDate: string;
  /** Called when allocations change so parent can re-fetch */
  onAllocationsChange?: (allocs: ContractSpaceAllocation[]) => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ContractSpaceManager({
  contractId,
  locationId,
  contractSeats,
  contractStatus,
  contractStartDate,
  contractEndDate,
  onAllocationsChange,
}: Props) {
  const [allocations, setAllocations] = useState<ContractSpaceAllocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  // Unit picker state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [availableUnits, setAvailableUnits] = useState<AvailableUnit[]>([]);
  const [unitsLoading, setUnitsLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  const isLocked = ["active", "renewal_in_progress", "renewed", "completed"].includes(contractStatus);
  const isEditable = ["draft", "sent", "viewed", "accepted"].includes(contractStatus);

  const allocatedSeats = allocations.reduce((sum, a) => sum + (a.space_unit?.capacity ?? 0), 0);

  const fetchAllocations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/space-allocations`);
      if (res.ok) {
        const json = await res.json();
        const active = (json.data || []).filter(
          (a: ContractSpaceAllocation) => a.status === "active"
        );
        setAllocations(active);
        onAllocationsChange?.(active);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [contractId, onAllocationsChange]);

  useEffect(() => {
    fetchAllocations();
  }, [fetchAllocations]);

  /* ---- Fetch available units for picker ---- */
  const openPicker = async () => {
    if (!locationId) {
      toast.error("Contract has no location set");
      return;
    }
    setPickerOpen(true);
    setUnitsLoading(true);
    setSelectedIds([]);
    try {
      const res = await fetch(`/api/locations/${locationId}/space-units?is_active=true`);
      const json = await res.json();
      const units: AvailableUnit[] = json.data || [];
      // Exclude units already allocated to this contract
      const alreadyAllocatedIds = new Set(allocations.map((a) => a.space_unit_id));
      setAvailableUnits(units.filter((u) => !alreadyAllocatedIds.has(u.id)));
    } catch {
      toast.error("Failed to load units");
      setAvailableUnits([]);
    } finally {
      setUnitsLoading(false);
    }
  };

  /* ---- Compute available seats per unit ---- */
  const getAvailableSeats = (unit: AvailableUnit): number => {
    const activeAllocs = (unit.active_allocations || []).filter(
      (a) => a.status === "active"
    );
    // Each allocation uses up seats based on the contract's seats value.
    // For simplicity we assume each allocation claims the unit's full capacity
    // unless we track partial seat counts. Since units can be shared, show
    // the unit's total capacity and how many contracts currently use it.
    return unit.capacity;
  };

  const getActiveContractCount = (unit: AvailableUnit): number => {
    return (unit.active_allocations || []).filter(
      (a) => a.status === "active"
    ).length;
  };

  /* ---- Add selected units ---- */
  const handleAddUnits = async () => {
    if (selectedIds.length === 0) return;
    setAdding(true);
    let added = 0;
    for (const unitId of selectedIds) {
      try {
        const res = await fetch(`/api/contracts/${contractId}/space-allocations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            space_unit_id: unitId,
            start_date: contractStartDate,
            end_date: contractEndDate,
          }),
        });
        if (res.ok) added++;
        else {
          const err = await res.json().catch(() => null);
          if (err?.error) toast.error(err.error);
        }
      } catch {
        /* ignore */
      }
    }
    if (added > 0) {
      toast.success(`${added} unit${added > 1 ? "s" : ""} allocated`);
      fetchAllocations();
    }
    setPickerOpen(false);
    setAdding(false);
  };

  /* ---- Unlink ---- */
  const handleUnlink = async (allocationId: string) => {
    if (!window.confirm("Unlink this space unit from the contract?")) return;
    setUnlinkingId(allocationId);
    try {
      const res = await fetch(
        `/api/contracts/${contractId}/space-allocations?allocation_id=${allocationId}`,
        { method: "DELETE" }
      );
      if (res.ok) {
        toast.success("Space unit unlinked");
        setAllocations((prev) => {
          const next = prev.filter((a) => a.id !== allocationId);
          onAllocationsChange?.(next);
          return next;
        });
      } else {
        const json = await res.json().catch(() => null);
        toast.error(json?.error || "Failed to unlink");
      }
    } catch {
      toast.error("Failed to unlink");
    } finally {
      setUnlinkingId(null);
    }
  };

  /* ---- Validation summary ---- */
  const seatDiff = allocatedSeats - contractSeats;
  const hasWarning = allocations.length > 0 && seatDiff < 0;
  const hasSufficient = allocations.length > 0 && seatDiff >= 0;

  // Group available units by floor
  const byFloor = availableUnits.reduce<
    Record<string, { name: string; units: AvailableUnit[] }>
  >((acc, u) => {
    const key = u.floor?.id ?? "__nofloor__";
    const label = u.floor?.name ?? "No Floor Assigned";
    if (!acc[key]) acc[key] = { name: label, units: [] };
    acc[key].units.push(u);
    return acc;
  }, {});

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <LayoutGrid className="h-4 w-4" />
            Assigned Spaces
            {allocations.length > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                ({allocatedSeats}/{contractSeats} seats)
              </span>
            )}
          </CardTitle>
          {isEditable && locationId && (
            <Button size="sm" variant="outline" onClick={openPicker} className="h-7 text-xs">
              <Plus className="mr-1 h-3 w-3" />
              Add Unit
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Seat validation banner */}
        {hasWarning && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">Allocated space is smaller than commitment</p>
              <p>
                {allocatedSeats} seat{allocatedSeats !== 1 ? "s" : ""} allocated vs {contractSeats} seat{contractSeats !== 1 ? "s" : ""} committed ({Math.abs(seatDiff)} short)
              </p>
            </div>
          </div>
        )}
        {hasSufficient && (
          <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-1.5 text-xs text-green-800">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>
              {allocatedSeats} seat{allocatedSeats !== 1 ? "s" : ""} allocated for {contractSeats} committed
              {seatDiff > 0 ? ` (+${seatDiff} extra)` : ""}
            </span>
          </div>
        )}

        {/* Loading state */}
        {loading ? (
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <div key={i} className="h-10 bg-muted animate-pulse rounded" />
            ))}
          </div>
        ) : allocations.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-2">
            No space units assigned.{" "}
            {isEditable && locationId
              ? 'Click "Add Unit" to allocate spaces.'
              : ""}
          </p>
        ) : (
          <div className="space-y-1.5">
            {allocations.map((alloc) => {
              const unit = alloc.space_unit;
              return (
                <div
                  key={alloc.id}
                  className="flex items-center justify-between gap-2 p-2 rounded-md border bg-muted/20"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <code className="text-[10px] font-mono bg-muted px-1 py-0.5 rounded">
                        {unit?.code}
                      </code>
                      <span className="text-xs font-medium truncate">
                        {unit?.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge
                        variant="outline"
                        className={`text-[10px] px-1 py-0 h-4 leading-none ${
                          unit?.type ? TYPE_COLORS[unit.type as SpaceUnitType] || "" : ""
                        }`}
                      >
                        {unit?.type ? TYPE_LABELS[unit.type as SpaceUnitType] || unit.type : ""}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {unit?.capacity} seat{(unit?.capacity ?? 1) !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>
                  {isLocked ? (
                    <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive shrink-0"
                      disabled={unlinkingId === alloc.id}
                      onClick={() => handleUnlink(alloc.id)}
                      title="Unlink space unit"
                    >
                      {unlinkingId === alloc.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Unit Picker — inline expandable */}
        {pickerOpen && (
          <div className="rounded-lg border bg-muted/20 p-3 space-y-3 mt-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Select Units to Allocate</p>
              <button
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setPickerOpen(false)}
              >
                Cancel
              </button>
            </div>

            {unitsLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading available units...
              </div>
            ) : availableUnits.length === 0 ? (
              <p className="text-xs text-muted-foreground py-1">
                No available space units at this location.
              </p>
            ) : (
              <>
                {Object.entries(byFloor).map(([floorKey, { name: floorName, units: floorUnits }]) => (
                  <div key={floorKey}>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                      {floorName}
                    </p>
                    <div className="space-y-1">
                      {floorUnits.map((u) => {
                        const checked = selectedIds.includes(u.id);
                        const activeContracts = getActiveContractCount(u);
                        return (
                          <label
                            key={u.id}
                            className={`flex items-center gap-2.5 p-2 rounded-md border cursor-pointer transition-colors text-xs ${
                              checked
                                ? "bg-[#015E65]/5 border-[#015E65]/30"
                                : "bg-background border-border hover:bg-muted/30"
                            }`}
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() =>
                                setSelectedIds((prev) =>
                                  checked
                                    ? prev.filter((x) => x !== u.id)
                                    : [...prev, u.id]
                                )
                              }
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-[10px] font-bold">{u.code}</span>
                                <span className="font-medium truncate">{u.name}</span>
                              </div>
                              <div className="flex items-center gap-2 mt-0.5">
                                <Badge
                                  variant="outline"
                                  className={`text-[9px] px-1 py-0 h-3.5 leading-none ${TYPE_COLORS[u.type]}`}
                                >
                                  {TYPE_LABELS[u.type]}
                                </Badge>
                                <span className="text-muted-foreground">
                                  {getAvailableSeats(u)} seat{u.capacity !== 1 ? "s" : ""}
                                </span>
                                {activeContracts > 0 && (
                                  <span className="text-amber-600">
                                    ({activeContracts} contract{activeContracts > 1 ? "s" : ""} using)
                                  </span>
                                )}
                              </div>
                            </div>
                            {u.monthly_rate ? (
                              <span className="text-[10px] text-muted-foreground shrink-0">
                                ₹{u.monthly_rate.toLocaleString("en-IN")}/mo
                              </span>
                            ) : null}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {/* Selection summary + add button */}
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted-foreground">
                    {selectedIds.length} unit{selectedIds.length !== 1 ? "s" : ""} selected
                    {selectedIds.length > 0 && (
                      <>
                        {" "}
                        ({availableUnits
                          .filter((u) => selectedIds.includes(u.id))
                          .reduce((s, u) => s + u.capacity, 0)}{" "}
                        seats)
                      </>
                    )}
                  </span>
                  <Button
                    size="sm"
                    onClick={handleAddUnits}
                    disabled={selectedIds.length === 0 || adding}
                    className="h-7 text-xs"
                  >
                    {adding ? (
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                    ) : (
                      <Plus className="mr-1 h-3 w-3" />
                    )}
                    Allocate
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Validation helper — used by the parent contract page at activation */
/* ------------------------------------------------------------------ */

export interface SpaceValidationResult {
  allocatedSeats: number;
  contractSeats: number;
  isUnderAllocated: boolean;
  shortfall: number;
}

export function validateSpaceAllocation(
  allocations: ContractSpaceAllocation[],
  contractSeats: number
): SpaceValidationResult {
  const allocatedSeats = allocations.reduce(
    (sum, a) => sum + (a.space_unit?.capacity ?? 0),
    0
  );
  const shortfall = Math.max(0, contractSeats - allocatedSeats);
  return {
    allocatedSeats,
    contractSeats,
    isUnderAllocated: allocatedSeats < contractSeats,
    shortfall,
  };
}
