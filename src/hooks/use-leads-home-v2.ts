"use client";

import { useFetch } from "@/hooks/use-fetch";

/**
 * Whether the new Leads navigation is on (app_settings.leads_home_v2_enabled). Off while loading
 * and when the setting is missing, so nobody sees the new screens flicker in and then out.
 */
export function useLeadsHomeV2(): boolean {
  const { data } = useFetch<Record<string, string>>("/api/settings/public", {
    select: (json) => (json.data as Record<string, string>) ?? {},
  });
  return data?.leads_home_v2_enabled === "true";
}
