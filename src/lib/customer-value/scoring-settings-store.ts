/**
 * Customer Value — reading scoring settings from `app_settings`.
 *
 * Defaults live in code. An admin can override any of them by storing JSON under
 * the key below; the override is validated by `mergeSettings` before use, and a
 * broken override falls back to the defaults and says so, instead of turning
 * every customer into a D. Pure: the caller fetches the text.
 */

import {
  DEFAULT_SCORING_SETTINGS,
  mergeSettings,
  type ScoringSettings,
} from "@/lib/customer-value/scoring-settings";

export const SCORING_SETTINGS_KEY = "customer_value_scoring";

export interface LoadedSettings {
  settings: ScoringSettings;
  /** Short stable stamp of the settings used, stored with every score so a later change is traceable. */
  version: string;
  /** Set when an override existed but could not be used. */
  warning: string | null;
}

/** JSON with object keys sorted, so equal settings always stringify the same. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** An 8-character hex stamp (FNV-1a) of the settings. Not a security hash: a change detector. */
export function settingsVersion(settings: ScoringSettings): string {
  let h = 0x811c9dc5;
  for (const ch of stableStringify(settings)) {
    h ^= ch.codePointAt(0) as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function loadSettings(overrideText: string | null | undefined): LoadedSettings {
  const fallback = (warning: string | null): LoadedSettings => ({
    settings: DEFAULT_SCORING_SETTINGS,
    version: settingsVersion(DEFAULT_SCORING_SETTINGS),
    warning,
  });

  if (overrideText === null || overrideText === undefined || overrideText.trim() === "") return fallback(null);

  let parsed: unknown;
  try {
    parsed = JSON.parse(overrideText);
  } catch {
    return fallback("The scoring settings override is not valid JSON, so the defaults were used");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallback("The scoring settings override must be a JSON object, so the defaults were used");
  }
  try {
    const settings = mergeSettings(parsed as Partial<ScoringSettings>);
    return { settings, version: settingsVersion(settings), warning: null };
  } catch (err) {
    const why = err instanceof Error ? err.message.replace(/^Invalid scoring settings: /, "") : "invalid";
    return fallback(`The scoring settings override was rejected (${why}), so the defaults were used`);
  }
}
