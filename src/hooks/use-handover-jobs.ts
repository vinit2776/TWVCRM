"use client";

import { useFetch } from "@/hooks/use-fetch";

/** Whether handing over jobs is switched on (app_settings.handover_jobs_enabled). Off while loading or when missing. */
export function useHandoverJobsEnabled(): boolean {
  const { data } = useFetch<Record<string, string>>("/api/settings/public", {
    select: (json) => (json.data as Record<string, string>) ?? {},
  });
  return data?.handover_jobs_enabled === "true";
}
