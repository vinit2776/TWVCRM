"use client";

import { useFetch } from "@/hooks/use-fetch";

/**
 * Whether the new Leads navigation is on (app_settings.leads_home_v2_enabled). Off while loading
 * and when the setting is missing, so nobody sees the new screens flicker in and then out.
 */
export function useLeadsHomeV2(): boolean {
  return useLeadsHomeV2State().on;
}

/**
 * The same switch, plus whether it has been read yet. The Leads page waits for `ready` before it
 * picks its landing view, so it never shows the old tabs for a moment and then swaps them.
 */
export function useLeadsHomeV2State(): { on: boolean; ready: boolean } {
  const { data, loading } = useFetch<Record<string, string>>("/api/settings/public", {
    select: (json) => (json.data as Record<string, string>) ?? {},
  });
  return { on: data?.leads_home_v2_enabled === "true", ready: !loading };
}
