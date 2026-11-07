import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { queryEntityDef } from "@/lib/queries/registry";
import { fanOutQueryEvent, loadEntity, threadParticipantIds } from "@/lib/queries/server";
import type { QueryThread } from "@/lib/queries/types";
import { DEAD_BILL_STATUSES_FILTER } from "@/lib/constants";
import { checkAmountAgainstCeiling, type CeilingResult } from "@/lib/procurement/bill-edit-rules";

/** Payments on the bill that have not been reversed. */
export async function countStandingPayments(supabase: SupabaseClient, billId: string): Promise<number> {
  const { count } = await supabase
    .from("vendor_bill_payments")
    .select("*", { count: "exact", head: true })
    .eq("bill_id", billId)
    .is("reversed_at", null);
  return count ?? 0;
}

/** Columns that mark a bill as corrected; merged into the update that makes the correction. */
export function editedStamp(
  bill: { edit_count?: number | null },
  userId: string,
  summary: string,
) {
  return {
    edit_count: (bill.edit_count ?? 0) + 1,
    last_edited_at: new Date().toISOString(),
    last_edited_by: userId,
    last_edit_summary: summary.slice(0, 500),
  };
}

/** Checks a corrected pre-GST amount against the bill's PO (value or cycle cost, plus price tolerance). */
export async function checkBillAmountAgainstPo(
  supabase: SupabaseClient,
  bill: { id: string; po_id: string | null },
  newTotal: number,
): Promise<CeilingResult> {
  if (!bill.po_id) return { ok: true, outcome: { kind: "ok" } };

  const { data: po } = await supabase
    .from("purchase_orders")
    .select("po_type, total_ordered_amount, unit_cost_per_cycle, tolerance_percent")
    .eq("id", bill.po_id)
    .single();
  if (!po) return { ok: true, outcome: { kind: "ok" } };

  const isService = po.po_type === "service";
  const ceiling = isService && po.unit_cost_per_cycle
    ? Number(po.unit_cost_per_cycle)
    : Number(po.total_ordered_amount ?? 0);

  let priorInvoiced = 0;
  if (!isService) {
    const { data: others } = await supabase
      .from("vendor_bills")
      .select("total_amount")
      .eq("po_id", bill.po_id)
      .neq("id", bill.id)
      .not("approval_status", "in", DEAD_BILL_STATUSES_FILTER);
    priorInvoiced = (others ?? []).reduce((sum, b) => sum + Number(b.total_amount), 0);
  }

  return checkAmountAgainstCeiling({ newTotal, isService, ceiling, priorInvoiced, tolerancePercent: po.tolerance_percent });
}

/**
 * Posts a correction as a reply on the bill's open query (if any) and pages the
 * thread the same way a normal reply does, so the person who asked "total doesn't
 * match" hears that it was fixed. Failures are logged, never thrown — the
 * correction itself has already been saved.
 */
export async function replyOnOpenBillQueries(params: {
  billId: string;
  author: { id: string; role: string; full_name: string };
  message: string;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: open } = await admin
      .from("queries")
      .select("id, entity_id, audience, audience_roles, audience_user_ids")
      .eq("entity_type", "vendor_bill")
      .eq("entity_id", params.billId)
      .neq("status", "resolved");
    const def = queryEntityDef("vendor_bill");
    if (!open || open.length === 0 || !def) return;

    for (const q of open) {
      const { error } = await admin.from("query_messages").insert({
        query_id: q.id,
        event_type: "message",
        body: params.message,
        created_by: params.author.id,
      });
      if (error) {
        console.error(`[bill-edit] query reply failed for ${q.id}:`, error.message);
        continue;
      }
      await admin.from("queries").update({ updated_at: new Date().toISOString(), escalated_at: null }).eq("id", q.id);

      const [entity, participantIds] = await Promise.all([
        loadEntity(admin, "vendor_bill", q.entity_id),
        threadParticipantIds(admin, q.id),
      ]);
      await fanOutQueryEvent(admin, {
        queryId: q.id,
        def,
        targeting: {
          audience: q.audience as QueryThread["audience"],
          audience_roles: q.audience_roles as QueryThread["audience_roles"],
          audience_user_ids: q.audience_user_ids as string[],
        },
        entitySummary: entity?.summary ?? null,
        entityId: q.entity_id,
        author: params.author,
        participantIds,
        headline: "Bill corrected",
        message: params.message,
        notificationType: "query_reply",
      });
    }
  } catch (err) {
    console.error("[bill-edit] query reply failed:", err instanceof Error ? err.message : err);
  }
}
