import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendWhatsApp } from "@/lib/whatsapp";
import { queryEntityDef } from "@/lib/queries/registry";
import { resolveRecipients, type CandidateUser } from "@/lib/queries/audience";
import { loadEntitySummaries, entityKey, entityLabel } from "@/lib/queries/server";
import { queryUrl } from "@/lib/queries/notify";
import type { QueryTargeting } from "@/lib/queries/types";

/**
 * GET /api/cron/query-escalation
 *
 * Runs every 6 hours (see vercel.json). Escalates any open query thread whose
 * last message is 48h+ old with no reply, via WhatsApp — same "silence past a
 * threshold" pattern as facility-sla-check, adapted to threads.
 *
 * Renamed from billing-query-escalation when queries were generalised beyond
 * billing statements (00420). Two behaviour changes came with that:
 *
 *   * It walks every entity type via the registry, not just statements.
 *   * It pages the thread's own audience rather than a fixed role list, so a
 *     query addressed to one person escalates to that person instead of
 *     WhatsApping everyone in accounts/manager/sales_rep.
 *
 * WhatsApp needs an approved MSG91 template — set
 * MSG91_WA_TEMPLATE_BILLING_QUERY_ESCALATION once one exists. Until then this
 * cron still runs (and still stamps escalated_at, so nothing is silently
 * skipped once the template goes live) but the send is a no-op, the same
 * graceful degradation as WA_TEMPLATE_ASSIGNED in facility-notifications.ts.
 */
const ESCALATE_AFTER_HOURS = 48;

const WA_TEMPLATE_QUERY_ESCALATION =
  process.env.MSG91_WA_TEMPLATE_BILLING_QUERY_ESCALATION?.trim() || undefined;

interface EscalationRow {
  id: string;
  entity_type: string;
  entity_id: string;
  created_by: string;
  audience: QueryTargeting["audience"];
  audience_roles: string[];
  audience_user_ids: string[];
  messages: Array<{ created_at: string; created_by: string }>;
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - ESCALATE_AFTER_HOURS * 60 * 60 * 1000).toISOString();

  const { data: openQueries, error } = await supabase
    .from("queries")
    .select(`
      id, entity_type, entity_id, created_by, audience, audience_roles, audience_user_ids,
      messages:query_messages(created_at, created_by)
    `)
    .eq("status", "open")
    .is("escalated_at", null);

  if (error) {
    console.error("[query-escalation] query failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (openQueries ?? []) as unknown as EscalationRow[];
  const toEscalate = rows.filter((q) => {
    if (!queryEntityDef(q.entity_type)) return false;
    const sorted = [...q.messages].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const last = sorted[sorted.length - 1];
    return !!last && last.created_at < cutoff;
  });

  if (toEscalate.length === 0) {
    return NextResponse.json({ checked: rows.length, escalated: 0, whatsapp_sent: 0 });
  }

  const [{ data: users }, summaries] = await Promise.all([
    supabase.from("users").select("id, role, phone, is_active").eq("is_active", true),
    loadEntitySummaries(
      supabase,
      toEscalate.map((q) => ({ entity_type: q.entity_type, entity_id: q.entity_id })),
    ),
  ]);

  const candidates = (users ?? []) as Array<CandidateUser & { phone: string | null }>;
  const phoneById = new Map(candidates.map((u) => [u.id, u.phone]));

  let sentCount = 0;

  for (const q of toEscalate) {
    const def = queryEntityDef(q.entity_type);
    if (!def) continue;

    const targeting: QueryTargeting = {
      audience: q.audience,
      audience_roles: q.audience_roles as QueryTargeting["audience_roles"],
      audience_user_ids: q.audience_user_ids,
    };

    // Page whoever owes the answer. The asker is excluded as the "author"
    // here — chasing them about their own unanswered question is noise.
    const { alert } = resolveRecipients({
      query: targeting,
      def,
      candidates,
      participantIds: [],
      authorId: q.created_by,
    });

    const phones = [...new Set(alert.map((id) => phoneById.get(id)).filter((p): p is string => !!p))];
    const label = entityLabel(def, summaries.get(entityKey(q.entity_type, q.entity_id)) ?? null);

    if (WA_TEMPLATE_QUERY_ESCALATION && phones.length > 0) {
      await Promise.allSettled(
        phones.map((phone) =>
          sendWhatsApp({
            to: phone,
            template: WA_TEMPLATE_QUERY_ESCALATION,
            params: [label, `${ESCALATE_AFTER_HOURS}h`, queryUrl(q.id)],
            entityType: def.auditEntityType,
            entityId: q.entity_id,
          }),
        ),
      );
      sentCount++;
    }

    await supabase.from("queries").update({ escalated_at: new Date().toISOString() }).eq("id", q.id);
  }

  return NextResponse.json({
    checked: rows.length,
    escalated: toEscalate.length,
    whatsapp_sent: sentCount,
    whatsapp_template_configured: !!WA_TEMPLATE_QUERY_ESCALATION,
  });
}
