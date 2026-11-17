"use client";

import { useEffect, useRef, useState } from "react";
import type { AmcConflict } from "@/lib/procurement/amc-overlap";

/**
 * Live AMCs already covering each asset during the given dates. Advisory: any failure, or missing
 * dates, simply yields no warnings. Each asset is looked up once per date range.
 */
export function useAmcOverlap(assetIds: string[], start: string | null | undefined, end: string | null | undefined, excludePrId?: string): Record<string, AmcConflict[]> {
  const [conflicts, setConflicts] = useState<Record<string, AmcConflict[]>>({});
  const asked = useRef(new Set<string>());
  const key = assetIds.filter(Boolean).sort().join(",");

  useEffect(() => {
    if (!start || !end || end <= start) return;
    const fresh = key.split(",").filter((id) => id && !asked.current.has(`${id}|${start}|${end}`));
    if (fresh.length === 0) return;
    fresh.forEach((id) => asked.current.add(`${id}|${start}|${end}`));
    const params = new URLSearchParams({ asset_ids: fresh.join(","), start, end });
    if (excludePrId) params.set("exclude_pr", excludePrId);
    fetch(`/api/procurement/amc-overlap?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => {
        if (!res?.conflicts) return;
        setConflicts((prev) => {
          const next = { ...prev };
          for (const id of fresh) delete next[id];
          return { ...next, ...res.conflicts };
        });
      })
      .catch(() => null);
  }, [key, start, end, excludePrId]);

  return conflicts;
}
