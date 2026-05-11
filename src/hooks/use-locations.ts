"use client";

import { useFetch } from "./use-fetch";
import type { Location } from "@/types";

export function useLocations(activeOnly = true) {
  const result = useFetch<Location[]>(
    `/api/locations${activeOnly ? "?is_active=true" : ""}`,
    { initialData: [], select: (json) => (json.data as Location[]) || [] },
  );
  return { locations: result.data ?? [], loading: result.loading, refetch: result.refetch };
}
