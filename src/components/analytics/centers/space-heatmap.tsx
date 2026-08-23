"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { ROOM_TYPE_LABELS, type HeatmapUnit } from "./types";

// Tailwind's blue scale, light -> dark = low -> high occupancy. Matches the
// existing heatmap precedent in admin/access-analytics-charts.tsx (a small
// hardcoded ramp + a lookup function), not a design-system component.
const HEAT_RAMP = [
  "#eff6ff", "#dbeafe", "#bfdbfe", "#93c5fd", "#60a5fa",
  "#3b82f6", "#2563eb", "#1d4ed8", "#1e40af", "#1e3a8a",
];

function heatColor(pct: number): string {
  const idx = Math.min(HEAT_RAMP.length - 1, Math.floor((pct / 100) * HEAT_RAMP.length));
  return HEAT_RAMP[idx];
}

function heatTextColor(pct: number): string {
  return pct >= 55 ? "#ffffff" : "#0b0b0b";
}

export function SpaceHeatmap({ units, loading }: { units: HeatmapUnit[]; loading: boolean }) {
  const centers = useMemo(() => {
    const byId = new Map<string, string>();
    for (const u of units) byId.set(u.location_id, u.location_name);
    return Array.from(byId.entries()).map(([id, name]) => ({ id, name }));
  }, [units]);

  const [activeCenterId, setActiveCenterId] = useState<string | null>(null);
  const effectiveCenterId = activeCenterId ?? centers[0]?.id ?? null;

  const mostOccupied = useMemo(
    () => units.reduce((best, u) => (u.occupancy_pct > (best?.occupancy_pct ?? -1) ? u : best), null as HeatmapUnit | null),
    [units]
  );
  const highestRevenue = useMemo(
    () => units.reduce((best, u) => (u.monthly_revenue > (best?.monthly_revenue ?? -1) ? u : best), null as HeatmapUnit | null),
    [units]
  );

  const visibleUnits = units
    .filter((u) => u.location_id === effectiveCenterId)
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  if (loading) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">Space heat map</CardTitle></CardHeader>
        <CardContent><div className="h-64 animate-pulse rounded-md bg-muted/40" /></CardContent>
      </Card>
    );
  }

  if (units.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Spotlight icon="🔥" label="Most occupied space" unit={mostOccupied} metric="occupancy" />
        <Spotlight icon="💰" label="Highest revenue space" unit={highestRevenue} metric="revenue" />
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Space heat map</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            {centers.map((c) => (
              <Button
                key={c.id}
                size="sm"
                variant={c.id === effectiveCenterId ? "default" : "outline"}
                onClick={() => setActiveCenterId(c.id)}
              >
                {c.name}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {visibleUnits.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No active spaces at this center.</p>
          ) : (
            <>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-1.5">
                {visibleUnits.map((u) => {
                  const vacant = u.occupancy_pct === 0;
                  return (
                    <div
                      key={u.unit_id}
                      className={`relative flex min-h-[62px] flex-col justify-between rounded-md p-2 text-xs ${vacant ? "border border-dashed border-muted-foreground/40 bg-muted/20" : ""}`}
                      style={vacant ? undefined : { background: heatColor(u.occupancy_pct), color: heatTextColor(u.occupancy_pct) }}
                      title={`${u.code} — ${ROOM_TYPE_LABELS[u.type] ?? u.type} — ${u.occupancy_pct}% occupied — ${u.monthly_revenue > 0 ? formatCurrency(u.monthly_revenue) + "/mo" : "no current tenant"}`}
                    >
                      <span className={`absolute right-1.5 top-1.5 text-[10px] font-semibold ${vacant ? "text-muted-foreground" : "opacity-80"}`}>
                        {u.occupancy_pct}%
                      </span>
                      <span className={`text-[11px] font-bold ${vacant ? "text-muted-foreground" : ""}`}>{u.code}</span>
                      <span className={`text-[10px] ${vacant ? "text-muted-foreground" : "opacity-85"}`}>
                        {u.capacity} seat{u.capacity !== 1 ? "s" : ""}
                        {u.monthly_revenue > 0 ? ` · ${formatCurrency(u.monthly_revenue)}/mo` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>0% occupied</span>
                <span className="flex h-2.5 max-w-[180px] flex-1 overflow-hidden rounded-full">
                  {HEAT_RAMP.map((c) => <span key={c} className="flex-1" style={{ background: c }} />)}
                </span>
                <span>100% occupied</span>
                <span className="ml-3 inline-flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-muted-foreground/40" />
                  Vacant now
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Spotlight({
  icon, label, unit, metric,
}: {
  icon: string;
  label: string;
  unit: HeatmapUnit | null;
  metric: "occupancy" | "revenue";
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 pt-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-lg">{icon}</span>
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
          {unit ? (
            <>
              <div className="truncate text-base font-bold">{unit.code} · {unit.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {unit.location_name} · {ROOM_TYPE_LABELS[unit.type] ?? unit.type} ·{" "}
                {metric === "occupancy" ? `${unit.occupancy_pct}% of the period` : `${formatCurrency(unit.monthly_revenue)}/mo`}
              </div>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">No data</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
