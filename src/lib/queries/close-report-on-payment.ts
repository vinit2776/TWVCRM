import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import { queryEntityDef, type EntityRow } from "./registry";
import { fanOutQueryEvent, threadParticipantIds, entityLabel, loadEntity } from "./server";

interface RecordedPayment {
  id: string;
}

/**
 * Accounts just recorded a payment on an invoice: close the oldest open report
 * the credit recorded on that invoice now covers, if any. A partial payment
 * leaves the report open. Both the coverage test and the close are one database
 * function (close_covered_payment_report, 00646) so the report, its history
 * line and its thread move together and the rule lives in one place.
 *
 * Never throws. The payment is already in the ledger and must not be rolled
 * back or reported as failed because a report could not be closed; an
 * unclosed report just stays in To verify for accounts to settle by hand.
 */
export async function closeReportForRecordedPayment(
  admin: SupabaseClient,
  payment: RecordedPayment,
  actor: { id: string; role: string; full_name: string },
): Promise<{ reportId: string } | null> {
  try {
    const { data: closed, error: closeErr } = await admin.rpc("close_covered_payment_report", {
      p_payment_id: payment.id,
      p_actor: actor.id,
    });
    if (closeErr) {
      console.error("[payment] could not close the covered payment report:", closeErr.message);
      return null;
    }
    const row = (closed as Array<{
      report_id: string;
      query_id: string;
      reported_by: string;
      entity_type: string;
      entity_id: string;
    }> | null)?.[0];
    if (!row) return null;

    const def = queryEntityDef(row.entity_type);
    if (def) {
      const loaded = await loadEntity(admin, row.entity_type, row.entity_id);
      await fanOutQueryEvent(admin, {
        queryId: row.query_id,
        def,
        targeting: { audience: "users", audience_roles: [], audience_user_ids: [row.reported_by] },
        entitySummary: loaded?.summary ?? null,
        entityId: row.entity_id,
        author: actor,
        participantIds: await threadParticipantIds(admin, row.query_id),
        headline: "Reported payment verified",
        message: "Payment recorded on the invoice; report closed.",
        notificationType: "payment_report_verified",
      });
      void logAudit(admin, {
        entityType: def.auditEntityType,
        entityId: (loaded?.row ? def.auditEntityId(loaded.row as EntityRow) : null) ?? row.entity_id,
        action: "payment_report_verified",
        performedBy: actor.id,
        changes: {
          payment_report_id: { old: null, new: row.report_id },
          status: { old: "reported", new: "verified" },
          billing_payment_id: { old: null, new: payment.id },
          context: { old: null, new: entityLabel(def, loaded?.summary ?? null) },
        },
      });
    }
    return { reportId: row.report_id };
  } catch (err) {
    console.error("[payment] closing the matching payment report failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
