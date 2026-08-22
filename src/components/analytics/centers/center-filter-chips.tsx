"use client";

import { Button } from "@/components/ui/button";

export function CenterFilterChips({
  centers,
  activeIds,
  onToggle,
}: {
  centers: Array<{ location_id: string; location_name: string }>;
  activeIds: Set<string>;
  onToggle: (locationId: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {centers.map((c) => {
        const active = activeIds.has(c.location_id);
        return (
          <Button
            key={c.location_id}
            type="button"
            size="sm"
            variant={active ? "secondary" : "outline"}
            className={active ? "" : "opacity-50"}
            onClick={() => onToggle(c.location_id)}
          >
            {c.location_name}
          </Button>
        );
      })}
    </div>
  );
}
