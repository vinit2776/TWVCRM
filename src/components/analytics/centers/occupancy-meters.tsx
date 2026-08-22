"use client";

import type { CenterSummary } from "./types";

export function OccupancyMeters({ centers }: { centers: CenterSummary[] }) {
  const sorted = [...centers].sort((a, b) => b.occupancy_pct - a.occupancy_pct);

  if (sorted.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No centers match the current filters.</p>;
  }

  return (
    <div className="space-y-4">
      {sorted.map((c) => (
        <div key={c.location_id} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{c.location_name}</span>
            <span className="text-sm font-semibold">
              {c.occupancy_pct}%
              <span className="ml-1.5 font-normal text-muted-foreground">
                {c.occupied_seats} / {c.capacity} seats
              </span>
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-blue-100">
            <div
              className={`h-full rounded-full ${c.occupancy_pct < 60 ? "bg-red-500" : c.occupancy_pct < 75 ? "bg-amber-500" : "bg-blue-600"}`}
              style={{ width: `${Math.min(100, c.occupancy_pct)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
