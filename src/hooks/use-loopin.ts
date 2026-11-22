"use client";

import { useFetch } from "@/hooks/use-fetch";

/** Whether Keep informed is switched on (app_settings.lead_loopin_enabled). Off while loading or when missing. */
export function useLoopinEnabled(): boolean {
  const { data } = useFetch<Record<string, string>>("/api/settings/public", {
    select: (json) => (json.data as Record<string, string>) ?? {},
  });
  return data?.lead_loopin_enabled === "true";
}
