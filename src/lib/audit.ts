import { SupabaseClient } from "@supabase/supabase-js";
import type { AuditAction, AuditEntityType } from "@/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Log an event to the audit_trail table.
 * Fires and forgets — does not throw on failure so it never blocks the main operation.
 *
 * performed_by is a UUID FK to users(id). Non-human callers (webhooks, cron jobs,
 * the Tally bridge) pass sentinel labels like "system" or "tally-bridge" instead of
 * a user id — those never resolve to a UUID, so Postgres rejected the insert outright
 * with "invalid input syntax for type uuid" and the row was silently dropped (logAudit
 * doesn't throw on failure, so callers never saw it fail). Any non-UUID value is
 * normalized to NULL here and preserved as `_actor_label` in the changes payload
 * instead, so the entry is still attributable without breaking the FK.
 */
export async function logAudit(
  supabase: SupabaseClient,
  params: {
    entityType: AuditEntityType;
    entityId: string;
    action: AuditAction;
    performedBy: string | null;
    changes?: Record<string, { old: unknown; new: unknown }>;
  }
) {
  const { entityType, entityId, action, performedBy, changes } = params;
  const isUuid = !!performedBy && UUID_RE.test(performedBy);

  const { error } = await supabase.from("audit_trail").insert({
    entity_type: entityType,
    entity_id: entityId,
    action,
    performed_by: isUuid ? performedBy : null,
    changes: {
      ...(changes || {}),
      ...(!isUuid && performedBy ? { _actor_label: { old: null, new: performedBy } } : {}),
    },
  });

  if (error) {
    console.error(`[audit] failed to log ${action} on ${entityType}/${entityId}:`, error.message);
  }
}

/**
 * Log a detail-page view for the activity storyboard. Reuses the existing
 * action:"view" convention (see the unifi voucher-reveal route) instead of a
 * parallel logging path, so adding view-tracking to another detail page is
 * a one-line call rather than hand-rolled logAudit boilerplate.
 * Fire-and-forget — never blocks the response.
 */
export async function logView(
  supabase: SupabaseClient,
  params: { entityType: AuditEntityType; entityId: string; performedBy: string | null }
) {
  await logAudit(supabase, { ...params, action: "view" });
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
