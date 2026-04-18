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
 * Log an email-send event as a lead activity.
 * Fires and forgets — does not throw on failure so it never blocks the main operation.
 */
export async function logEmailActivity(
  supabase: SupabaseClient,
  params: {
    leadId: string;
    subject: string;
    description: string;
    createdBy: string;
  }
) {
  const { leadId, subject, description, createdBy } = params;

  await supabase.from("activities").insert({
    lead_id: leadId,
    type: "email",
    subject,
    description,
    created_by: createdBy,
  }).then(({ error }) => {
    if (error) console.error("Failed to log email activity:", error.message);
  });
}

/**
 * Log a WhatsApp-send event as a lead activity (stored as a note so it appears
 * in the lead timeline without requiring a schema change).
 * Fires and forgets — does not throw on failure so it never blocks the main operation.
 */
export async function logWhatsAppActivity(
  supabase: SupabaseClient,
  params: {
    leadId: string;
    subject: string;
    description: string;
    createdBy: string;
  }
) {
  const { leadId, subject, description, createdBy } = params;

  await supabase.from("activities").insert({
    lead_id: leadId,
    type: "note",
    subject: `📱 WhatsApp: ${subject}`,
    description,
    created_by: createdBy,
  }).then(({ error }) => {
    if (error) console.error("Failed to log WhatsApp activity:", error.message);
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
