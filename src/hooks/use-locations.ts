"use client";

import { useState, useEffect, useCallback } from "react";
import type { Location } from "@/types";

export function useLocations(activeOnly = true) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLocations = useCallback(async () => {
    setLoading(true);
    try {
      const params = activeOnly ? "?is_active=true" : "";
      const res = await fetch(`/api/locations${params}`);
      if (!res.ok) throw new Error("Failed to fetch locations");
      const json = await res.json();
      setLocations(json.data || []);
    } catch {
      setLocations([]);
    } finally {
      setLoading(false);
    }
  }, [activeOnly]);

  useEffect(() => {
    fetchLocations();
  }, [fetchLocations]);

  return { locations, loading, refetch: fetchLocations };
}
