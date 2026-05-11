/**
 * Reads finance-intelligence configuration from app_settings.
 *
 * One concern this module solves: every FI feature checks "am I enabled?"
 * on every invocation. Caching here would risk staleness; instead, we
 * batch-read all 11 FI keys in a single query (which is what the GET
 * endpoint for the settings page also does) and let the caller hold the
 * result for the lifetime of one request.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type FeatureKey =
  | "duplicate_detector"
  | "po_mismatch_alert"
  | "due_date_learning"
  | "batch_date_suggestion"
  | "amount_anomaly"
  | "repeat_charge_autofill"
  | "description_templates"
  | "invoice_gap_audit";

export interface FinanceIntelligenceConfig {
  enabled: boolean;                    // master toggle
  lookback_months: number;             // default 6
  log_retention_days: number;          // default 90
  features: Record<FeatureKey, boolean>;
}

const SETTING_KEYS = [
  "finance_intelligence_enabled",
  "finance_intelligence_lookback_months",
  "finance_intelligence_log_retention_days",
  "fi_feature_duplicate_detector",
  "fi_feature_po_mismatch_alert",
  "fi_feature_due_date_learning",
  "fi_feature_batch_date_suggestion",
  "fi_feature_amount_anomaly",
  "fi_feature_repeat_charge_autofill",
  "fi_feature_description_templates",
  "fi_feature_invoice_gap_audit",
] as const;

const FEATURE_KEY_MAP: Record<string, FeatureKey> = {
  fi_feature_duplicate_detector:    "duplicate_detector",
  fi_feature_po_mismatch_alert:     "po_mismatch_alert",
  fi_feature_due_date_learning:     "due_date_learning",
  fi_feature_batch_date_suggestion: "batch_date_suggestion",
  fi_feature_amount_anomaly:        "amount_anomaly",
  fi_feature_repeat_charge_autofill:"repeat_charge_autofill",
  fi_feature_description_templates: "description_templates",
  fi_feature_invoice_gap_audit:     "invoice_gap_audit",
};

/** Load the full FI config block. Tolerant of missing rows (defaults applied). */
export async function loadFinanceIntelligenceConfig(
  supabase: SupabaseClient,
): Promise<FinanceIntelligenceConfig> {
  const { data } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", SETTING_KEYS as unknown as string[]);

  const map = new Map<string, string>((data ?? []).map((r) => [r.key, r.value ?? ""]));
  const get = (k: string) => map.get(k) ?? "";

  const features: Record<FeatureKey, boolean> = {
    duplicate_detector:     true,
    po_mismatch_alert:      true,
    due_date_learning:      true,
    batch_date_suggestion:  true,
    amount_anomaly:         true,
    repeat_charge_autofill: true,
    description_templates:  true,
    invoice_gap_audit:      true,
  };
  for (const [dbKey, featKey] of Object.entries(FEATURE_KEY_MAP)) {
    const v = map.get(dbKey);
    if (v !== undefined) features[featKey] = v === "true";
  }

  return {
    enabled: get("finance_intelligence_enabled") !== "false",  // default true
    lookback_months: parseInt(get("finance_intelligence_lookback_months") || "6", 10),
    log_retention_days: parseInt(get("finance_intelligence_log_retention_days") || "90", 10),
    features,
  };
}

/** Quick check: is a specific feature on (and the master switch on)? */
export function isFeatureEnabled(
  config: FinanceIntelligenceConfig,
  feature: FeatureKey,
): boolean {
  return config.enabled && (config.features[feature] ?? true);
}

/** ISO date string N months ago (used by every history query). */
export function lookbackCutoff(monthsAgo: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo);
  return d.toISOString();
}
