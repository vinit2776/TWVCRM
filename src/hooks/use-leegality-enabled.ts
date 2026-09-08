"use client";

import { useFetch } from "@/hooks/use-fetch";

/**
 * Whether Leegality e-signing may be initiated right now (app_settings.leegality_enabled).
 * Defaults to `true` while loading and when the setting is unset, matching the
 * server-side default in isLeegalitySigningEnabled() — so the button doesn't
 * flicker disabled→enabled on every page load.
 */
export function useLeegalityEnabled(): { enabled: boolean; loading: boolean } {
  const { data, loading } = useFetch<Record<string, string>>("/api/settings/public", {
    select: (json) => (json.data as Record<string, string>) ?? {},
  });
  return { enabled: data?.leegality_enabled !== "false", loading };
}
