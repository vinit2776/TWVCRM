"use client";

import { useCallback, useEffect, useState } from "react";
import type { ExitView } from "@/lib/contract-exit-server";

/** Loads the live exit (with charges and settlement preview) for a contract. */
export function useExit(contractId: string) {
  const [view, setView] = useState<ExitView | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/contracts/${contractId}/exit`, { cache: "no-store" });
      if (!res.ok) { setView(null); return; }
      const json = await res.json();
      setView(json.data ?? null);
    } catch {
      setView(null);
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => { reload(); }, [reload]);
  return { view, loading, reload };
}
