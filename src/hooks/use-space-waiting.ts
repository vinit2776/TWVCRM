"use client";

import { useFetch } from "@/hooks/use-fetch";

/** Whether Waiting for space is switched on (app_settings.space_waiting_enabled). Off while loading or when missing. */
export function useSpaceWaitingEnabled(): boolean {
  const { data } = useFetch<Record<string, string>>("/api/settings/public", {
    select: (json) => (json.data as Record<string, string>) ?? {},
  });
  return data?.space_waiting_enabled === "true";
}
