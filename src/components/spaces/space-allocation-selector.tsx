"use client";

import { useState, useEffect } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import type { SpaceUnit, SpaceUnitType } from "@/types";

const TYPE_LABELS: Record<SpaceUnitType, string> = {
  hot_desk:       "Hot Desk",
  dedicated_desk: "Dedicated Desk",
  private_cabin:  "Private Cabin",
  managed_office: "Managed Office",
};

const TYPE_COLORS: Record<SpaceUnitType, string> = {
  hot_desk:       "bg-sky-100 text-sky-700 border-sky-200",
  dedicated_desk: "bg-blue-100 text-blue-700 border-blue-200",
  private_cabin:  "bg-violet-100 text-violet-700 border-violet-200",
  managed_office: "bg-pink-100 text-pink-700 border-pink-200",
};

interface Props {
  locationId: string;
  selectedUnitIds: string[];
  onChange: (ids: string[]) => void;
}

export function SpaceAllocationSelector({ locationId, selectedUnitIds, onChange }: Props) {
  const [units, setUnits] = useState<SpaceUnit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!locationId) return;
    setLoading(true);
    fetch(`/api/locations/${locationId}/space-units?is_active=true`)
      .then((r) => r.json())
      .then((json) => {
        // Show only vacant units (no active allocation) or already selected
        const data: SpaceUnit[] = json.data || [];
        const available = data.filter((u) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hasAlloc = (u as any).active_allocations?.length > 0;
          return !hasAlloc || selectedUnitIds.includes(u.id);
        });
        setUnits(available);
      })
      .catch(() => setUnits([]))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId]);

  const toggle = (id: string) => {
    onChange(
      selectedUnitIds.includes(id)
        ? selectedUnitIds.filter((x) => x !== id)
        : [...selectedUnitIds, id]
    );
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading available units…
      </div>
    );
  }

  if (units.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-1">
        No vacant space units at this location. Set up the floor plan first.
      </p>
    );
  }

  // Group by floor
  const byFloor = units.reduce<Record<string, { name: string; units: SpaceUnit[] }>>((acc, u) => {
    const key = u.floor_id ?? "__nofloor__";
    const label = u.floor?.name ?? "No Floor Assigned";
    if (!acc[key]) acc[key] = { name: label, units: [] };
    acc[key].units.push(u);
    return acc;
  }, {});

  const selectedUnits = units.filter((u) => selectedUnitIds.includes(u.id));
  const totalSeats = selectedUnits.reduce((s, u) => s + u.capacity, 0);
  const totalRate  = selectedUnits.reduce((s, u) => s + u.monthly_rate, 0);

  return (
    <div className="space-y-3">
      {Object.entries(byFloor).map(([floorKey, { name: floorName, units: floorUnits }]) => (
        <div key={floorKey}>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">{floorName}</p>
          <div className="space-y-1.5">
            {floorUnits.map((u) => {
              const checked = selectedUnitIds.includes(u.id);
              return (
                <label
                  key={u.id}
                  className={`flex items-center gap-3 p-2.5 rounded-md border cursor-pointer transition-colors ${
                    checked ? "bg-[#015E65]/5 border-[#015E65]/30" : "bg-background border-border hover:bg-muted/30"
                  }`}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(u.id)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-bold">{u.code}</span>
                      <span className="text-sm font-medium truncate">{u.name}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="outline" className={`text-[10px] px-1 py-0 h-4 leading-none ${TYPE_COLORS[u.type]}`}>
                        {TYPE_LABELS[u.type]}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{u.capacity} seat{u.capacity !== 1 ? "s" : ""}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold">₹{u.monthly_rate.toLocaleString("en-IN")}</p>
                    <p className="text-[10px] text-muted-foreground">/ month</p>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      ))}

      {/* Summary */}
      {selectedUnits.length > 0 && (
        <div className="rounded-md bg-[#015E65]/5 border border-[#015E65]/20 p-3 text-sm">
          <div className="flex justify-between items-center">
            <span className="font-medium text-[#015E65]">
              {selectedUnits.length} unit{selectedUnits.length !== 1 ? "s" : ""} selected
            </span>
            <span className="text-muted-foreground">{totalSeats} seat{totalSeats !== 1 ? "s" : ""}</span>
          </div>
          <div className="flex justify-between items-center mt-1">
            <span className="text-xs text-muted-foreground">Combined monthly rate</span>
            <span className="font-bold text-[#015E65]">₹{totalRate.toLocaleString("en-IN")}</span>
          </div>
        </div>
      )}
    </div>
  );
}
