/**
 * Writes to finance_suggestion_log.
 *
 * Every feature uses this to:
 *   1. Log when a suggestion is *shown* to the user (status='shown')
 *   2. Update the log when the user resolves it ('accepted'/'overridden'/
 *      'dismissed') so we can measure effectiveness
 *
 * The log is the source of truth for the effectiveness dashboard
 * ("Suggestion accepted in 87% of cases. Time saved estimate: 4.2 hrs/mo").
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FeatureKey } from "./settings";

export type EntityType = "vendor_bill" | "purchase_order" | "gst_invoice" | "contract_payment" | "booking";

export type UserAction = "shown" | "accepted" | "overridden" | "dismissed" | "ignored";

interface LogSuggestionInput {
  feature: FeatureKey;
  entity_type: EntityType;
  entity_id?: string;
  suggestion: Record<string, unknown>;
  context?: Record<string, unknown>;
  triggered_by?: string;
}

/**
 * Log a freshly-made suggestion. Returns the row id so the caller can
 * later call `resolveSuggestion(id, action, userValue)` when the user acts.
 *
 * Failure is non-fatal — we never want suggestion logging to break the
 * primary flow (e.g. saving a bill). Errors are swallowed but console-logged.
 */
export async function logSuggestion(
  supabase: SupabaseClient,
  input: LogSuggestionInput,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("finance_suggestion_log")
      .insert({
        feature: input.feature,
        entity_type: input.entity_type,
        entity_id: input.entity_id ?? null,
        suggestion: input.suggestion,
        user_action: "shown",
        context: input.context ?? null,
        triggered_by: input.triggered_by ?? null,
      })
      .select("id")
      .single();
    if (error) {
      console.warn("[fi-audit] logSuggestion failed:", error.message);
      return null;
    }
    return data?.id ?? null;
  } catch (e) {
    console.warn("[fi-audit] logSuggestion threw:", e);
    return null;
  }
}

/**
 * Update a previously-logged suggestion with the user's final action.
 * Called from API routes that record the user's choice (bill save, etc.).
 */
export async function resolveSuggestion(
  supabase: SupabaseClient,
  suggestionLogId: string,
  action: UserAction,
  userValue?: Record<string, unknown>,
): Promise<void> {
  try {
    await supabase
      .from("finance_suggestion_log")
      .update({
        user_action: action,
        user_value: userValue ?? null,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", suggestionLogId);
  } catch (e) {
    console.warn("[fi-audit] resolveSuggestion threw:", e);
  }
}

/**
 * One-shot helper: log + immediately resolve (when we know the action at
 * the same moment we make the suggestion). Used for batch-time suggestions
 * where there's no separate "user acts" event.
 */
export async function logAndResolve(
  supabase: SupabaseClient,
  input: LogSuggestionInput,
  action: UserAction,
  userValue?: Record<string, unknown>,
): Promise<void> {
  const id = await logSuggestion(supabase, input);
  if (id) await resolveSuggestion(supabase, id, action, userValue);
}
