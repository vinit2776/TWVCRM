import { SupabaseClient } from "@supabase/supabase-js";
import type { AuditAction, AuditEntityType } from "@/types";

/**
 * Log an event to the audit_trail table.
 * Fires and forgets — does not throw on failure so it never blocks the main operation.
 */
export async function logAudit(
  supabase: SupabaseClient,
  params: {
    entityType: AuditEntityType;
    entityId: string;
    action: AuditAction;
    performedBy: string;
    changes?: Record<string, { old: unknown; new: unknown }>;
  }
) {
  const { entityType, entityId, action, performedBy, changes } = params;

  await supabase.from("audit_trail").insert({
    entity_type: entityType,
    entity_id: entityId,
    action,
    performed_by: performedBy,
    changes: changes || {},
  });
}

/**
 * Compute a diff between two objects, returning only the fields that changed.
 */
export function diffChanges(
  oldData: Record<string, unknown>,
  newData: Record<string, unknown>
): Record<string, { old: unknown; new: unknown }> {
  const changes: Record<string, { old: unknown; new: unknown }> = {};

  for (const key of Object.keys(newData)) {
    // Skip metadata fields
    if (["updated_at", "created_at"].includes(key)) continue;

    const oldVal = oldData[key];
    const newVal = newData[key];

    // Simple equality check (works for primitives, stringify for objects)
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changes[key] = { old: oldVal, new: newVal };
    }
  }

  return changes;
}
