/**
 * process-deviations.ts — SERVER-ONLY
 *
 * Records that someone took a sanctioned exception path, so it can be reviewed
 * and coached on. See process-registry.ts for the definitions and the rule
 * that this is never a gate.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { deviationDefinition, findReason } from "@/lib/process-registry";

export interface RecordDeviationParams {
  key: string;
  entityType: string;
  entityId: string;
  locationId?: string | null;
  /** When the step should have happened, YYYY-MM-DD. */
  dueOn?: string | null;
  recordedBy: string;
  /** Who it counts against. Defaults to whoever recorded it. */
  accountableUserId?: string | null;
  reasonCode: string;
  comment?: string | null;
  amountAtStake?: number | null;
  details?: Record<string, unknown>;
}

/**
 * Insert one deviation. Idempotent per (deviation type, entity): a retried
 * request or a re-close can't count a person twice. Returns an error string
 * instead of throwing, so a caller deciding whether the deviation is part of
 * its own transaction can choose.
 */
export async function recordDeviation(
  admin: SupabaseClient,
  p: RecordDeviationParams,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const def = deviationDefinition(p.key);
  const reason = findReason(p.key, p.reasonCode);
  if (!def || !reason) return { ok: false, error: `Unknown deviation ${p.key} / ${p.reasonCode}` };

  const deviationType = p.key.slice(p.key.indexOf(".") + 1);

  const { error } = await admin.from("process_deviations").upsert(
    {
      process_key: def.process,
      deviation_type: deviationType,
      entity_type: p.entityType,
      entity_id: p.entityId,
      location_id: p.locationId ?? null,
      due_on: p.dueOn ?? null,
      recorded_by: p.recordedBy,
      accountable_user_id: p.accountableUserId ?? p.recordedBy,
      reason_code: p.reasonCode,
      comment: p.comment?.trim() || null,
      counts_against_person: reason.countsAgainstPerson,
      amount_at_stake: p.amountAtStake ?? null,
      details: p.details ?? {},
    },
    { onConflict: "deviation_type,entity_id", ignoreDuplicates: true },
  );

  if (error) {
    console.error("[process-deviation] insert failed:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
