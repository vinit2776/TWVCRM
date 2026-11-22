"use client";

import { useFetch } from "@/hooks/use-fetch";

/** Whether the tour Arrivals card is switched on (app_settings.tour_arrivals_enabled). Off while loading or when missing. */
export function useTourArrivalsEnabled(): boolean {
  const { data } = useFetch<Record<string, string>>("/api/settings/public", {
    select: (json) => (json.data as Record<string, string>) ?? {},
  });
  return data?.tour_arrivals_enabled === "true";
}
