import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import { queryEntityDef, type EntityRow } from "./registry";
import { fanOutQueryEvent, threadParticipantIds, entityLabel, loadEntity } from "./server";
import { pickReportToClose } from "./payment-reports";

interface RecordedPayment {
  id: string;
  amount: number | string | null;
  tds_amount?: number | string | null;
  payment_mode: string;
  billing_statement_id: string;
}

/**
 * Accounts just recorded a payment on an invoice: close the payment report it
 * satisfies, if any. Matching is in pickReportToClose; the close itself is one
 * database function so the report, its history line and its thread move
 * together.
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
    const { data: open, error } = await admin
      .from("query_payment_reports")
      .select("id, status, target_kind, claimed_statement_id, amount, created_at")
      .eq("claimed_statement_id", payment.billing_statement_id)
      .eq("status", "reported")
      .eq("target_kind", "invoice");
    if (error || !open?.length) return null;

    const report = pickReportToClose(open, payment);
    if (!report) return null;

    const { data: closed, error: closeErr } = await admin.rpc("close_payment_report", {
      p_report_id: report.id,
      p_payment_id: payment.id,
      p_actor: actor.id,
    });
    if (closeErr) {
      console.error("[payment] could not close the matching payment report:", closeErr.message);
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
