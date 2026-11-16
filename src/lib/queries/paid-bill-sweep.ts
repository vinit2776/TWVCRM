import type { SupabaseClient } from "@supabase/supabase-js";
import { logAudit } from "@/lib/audit";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { queryUrl } from "./notify";
import { decidePaidQuery } from "./lifecycle";

/**
 * Daily pass over open vendor-bill queries whose bill has been paid.
 *
 * Payment never closes a query on the spot (see lifecycle.ts): the asker gets
 * one in-app nudge, then three days to confirm, then — only if the bill was
 * corrected, nobody has spoken since the payment and no one reopened it — the
 * system closes it as "Resolved by payment". Staff-facing only: in-app
 * notification and a timeline event, no email, WhatsApp or customer contact.
 */

interface OpenBillQuery {
  id: string;
  entity_id: string;
  created_by: string;
  bill_corrected_at: string | null;
  paid_nudged_at: string | null;
  messages: Array<{ event_type: string; created_at: string; created_by: string }>;
}

export interface PaidBillSweepResult {
  checked: number;
  nudged: number;
  auto_closed: number;
  flagged: number;
}

export async function sweepPaidBillQueries(admin: SupabaseClient, now: Date): Promise<PaidBillSweepResult> {
  const result: PaidBillSweepResult = { checked: 0, nudged: 0, auto_closed: 0, flagged: 0 };

  const { data: queries, error } = await admin
    .from("queries")
    .select("id, entity_id, created_by, bill_corrected_at, paid_nudged_at, messages:query_messages(event_type, created_at, created_by)")
    .eq("entity_type", "vendor_bill")
    .eq("status", "open");
  if (error) {
    console.error("[query-digest] paid-bill sweep load failed:", error.message);
    return result;
  }
  const open = (queries ?? []) as unknown as OpenBillQuery[];
  if (open.length === 0) return result;

  const billIds = [...new Set(open.map((q) => q.entity_id))];
  const { data: bills } = await admin
    .from("vendor_bills")
    .select("id, bill_number, payment_status")
    .in("id", billIds);
  const paidBills = new Map(
    ((bills ?? []) as Array<{ id: string; bill_number: string | null; payment_status: string }>)
      .filter((b) => b.payment_status === "paid")
      .map((b) => [b.id, b]),
  );
  if (paidBills.size === 0) return result;

  const { data: payments } = await admin
    .from("vendor_bill_payments")
    .select("bill_id, created_at")
    .in("bill_id", [...paidBills.keys()]);
  const paidAt = new Map<string, string>();
  for (const p of (payments ?? []) as Array<{ bill_id: string; created_at: string }>) {
    const cur = paidAt.get(p.bill_id);
    if (!cur || p.created_at > cur) paidAt.set(p.bill_id, p.created_at);
  }

  for (const q of open) {
    const bill = paidBills.get(q.entity_id);
    const billPaidAt = paidAt.get(q.entity_id);
    if (!bill || !billPaidAt) continue;
    result.checked++;

    const action = decidePaidQuery({
      status: "open",
      billPaidAt,
      billCorrected: !!q.bill_corrected_at,
      paidNudgedAt: q.paid_nudged_at,
      messages: q.messages,
      now,
    });
    const billLabel = bill.bill_number ?? "the bill";

    if (action === "flag_only") result.flagged++;

    if (action === "nudge") {
      const { error: stampErr } = await admin.from("queries").update({ paid_nudged_at: now.toISOString() }).eq("id", q.id).is("paid_nudged_at", null);
      if (stampErr) continue;
      await admin.from("query_messages").insert({ query_id: q.id, event_type: "paid_nudge", body: null, created_by: q.created_by });
      await createNotificationsForUsers([q.created_by], {
        type: "query_reply",
        title: "Bill paid — is your query answered?",
        body: `${billLabel} has been paid. Please confirm and close your query, or reply if it still needs something.`,
        url: queryUrl(q.id),
        entityType: "vendor_bill",
        entityId: q.entity_id,
      });
      result.nudged++;
    }

    if (action === "auto_close") {
      const { error: closeErr } = await admin
        .from("queries")
        .update({ status: "resolved", resolved_by: q.created_by, resolved_at: now.toISOString(), resolution_kind: "payment" })
        .eq("id", q.id)
        .eq("status", "open");
      if (closeErr) continue;
      await admin.from("query_messages").insert({
        query_id: q.id,
        event_type: "auto_resolved",
        body: "Bill paid and no reply after the reminder",
        created_by: q.created_by,
      });
      await createNotificationsForUsers([q.created_by], {
        type: "query_reply",
        title: "Query closed — resolved by payment",
        body: `${billLabel} was paid and there was no reply to the reminder, so the query was closed. You can reopen it.`,
        url: queryUrl(q.id),
        entityType: "vendor_bill",
        entityId: q.entity_id,
      });
      void logAudit(admin, {
        entityType: "vendor_bill",
        entityId: q.entity_id,
        action: "query_auto_resolved",
        performedBy: q.created_by,
        changes: { query_id: { old: null, new: q.id }, resolution_kind: { old: null, new: "payment" } },
      });
      result.auto_closed++;
    }
  }
  return result;
}
