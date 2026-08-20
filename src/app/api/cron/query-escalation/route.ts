import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendWhatsApp } from "@/lib/whatsapp";
import { queryEntityDef } from "@/lib/queries/registry";
import { resolveRecipients, type CandidateUser } from "@/lib/queries/audience";
import { loadEntitySummaries, entityKey, entityLabel } from "@/lib/queries/server";
import { emailQueryEvent, queryUrl } from "@/lib/queries/notify";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { decideChase, ESCALATE_AFTER_HOURS } from "@/lib/queries/chase";
import type { QueryTargeting } from "@/lib/queries/types";
import type { UserRole } from "@/types";

import { withCronHealth } from "@/lib/cron-ping";

/**
 * GET /api/cron/query-escalation
 *
 * The chase loop. Runs every 6 hours (see vercel.json) and asks each open
 * query whether it needs chasing — the rules live in decideChase()
 * (src/lib/queries/chase.ts) so they can be unit-tested rather than buried in
 * a cron nobody runs locally.
 *
 * Two triggers, one pass:
 *   • escalate — 48h of silence (the original behaviour from #433)
 *   • nudge    — past the needed_by date the asker set
 *
 * Every chase goes to the thread's own audience, so a query addressed to one
 * person chases that person instead of paging all of accounts. Once a thread
 * is 3+ days past due, admin and manager are added on top.
 *
 * Channels, in increasing order of interruption:
 *   in-app + email  — every chase
 *   WhatsApp        — escalations only, and only once
 *                     MSG91_WA_TEMPLATE_BILLING_QUERY_ESCALATION is set.
 *
 * That template needs MSG91 approval. Until it exists the cron still runs,
 * still evaluates, still chases by in-app and email, and still stamps its
 * timestamps — so nothing is silently skipped the day the template goes live.
 * Same graceful degradation as WA_TEMPLATE_ASSIGNED in
 * facility-notifications.ts. The env var keeps its original BILLING_ name so
 * that setting it needs no code change.
 */
export const dynamic = "force-dynamic";

const WA_TEMPLATE_QUERY_ESCALATION =
  process.env.MSG91_WA_TEMPLATE_BILLING_QUERY_ESCALATION?.trim() || undefined;

/** Added to the recipients once a thread is well past its due date. */
const MANAGEMENT_ROLES: readonly UserRole[] = ["admin", "manager"];

interface ChaseRow {
  id: string;
  entity_type: string;
  entity_id: string;
  created_by: string;
  status: "open" | "resolved";
  needed_by: string | null;
  escalated_at: string | null;
  last_nudged_at: string | null;
  audience: QueryTargeting["audience"];
  audience_roles: string[];
  audience_user_ids: string[];
  messages: Array<{ created_at: string }>;
}

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();

  const { data, error } = await supabase
    .from("queries")
    .select(`
      id, entity_type, entity_id, created_by, status, needed_by,
      escalated_at, last_nudged_at, audience, audience_roles, audience_user_ids,
      messages:query_messages(created_at)
    `)
    .eq("status", "open");

  if (error) {
    console.error("[query-chase] load failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as ChaseRow[];

  const due = rows
    .map((q) => ({
      q,
      decision: decideChase({
        status: q.status,
        needed_by: q.needed_by,
        escalated_at: q.escalated_at,
        last_nudged_at: q.last_nudged_at,
        // ISO-8601 sorts lexicographically, so the max string is the latest.
        last_message_at: q.messages.length
          ? (q.messages.map((m) => m.created_at).sort().at(-1) ?? null)
          : null,
        now,
      }),
    }))
    .filter(({ q, decision }) => decision.kind !== "none" && !!queryEntityDef(q.entity_type));

  if (due.length === 0) {
    return NextResponse.json({
      checked: rows.length,
      nudged: 0,
      escalated: 0,
      whatsapp_sent: 0,
      whatsapp_template_configured: !!WA_TEMPLATE_QUERY_ESCALATION,
    });
  }

  const [{ data: users }, summaries] = await Promise.all([
    supabase.from("users").select("id, role, email, phone, is_active").eq("is_active", true),
    loadEntitySummaries(
      supabase,
      due.map(({ q }) => ({ entity_type: q.entity_type, entity_id: q.entity_id })),
    ),
  ]);

  const candidates = (users ?? []) as Array<CandidateUser & { email: string | null; phone: string | null }>;
  const byId = new Map(candidates.map((u) => [u.id, u]));

  let nudged = 0;
  let escalated = 0;
  let whatsappSent = 0;

  for (const { q, decision } of due) {
    const def = queryEntityDef(q.entity_type);
    if (!def) continue;

    const targeting: QueryTargeting = {
      audience: q.audience,
      audience_roles: q.audience_roles as QueryTargeting["audience_roles"],
      audience_user_ids: q.audience_user_ids,
    };

    // Chase whoever owes the answer. The asker is passed as the author so
    // they're never chased about their own unanswered question.
    const { notify, alert } = resolveRecipients({
      query: targeting,
      def,
      candidates,
      participantIds: [],
      authorId: q.created_by,
    });

    const recipients = new Set(notify);
    const alertSet = new Set(alert);
    if (decision.involveManagement) {
      for (const u of candidates) {
        if (u.id !== q.created_by && (MANAGEMENT_ROLES as readonly string[]).includes(u.role)) {
          recipients.add(u.id);
          alertSet.add(u.id);
        }
      }
    }

    const label = entityLabel(def, summaries.get(entityKey(q.entity_type, q.entity_id)) ?? null);
    const isEscalation = decision.kind === "escalate";
    const headline = isEscalation ? "Query still unanswered" : "Query is overdue";
    const reason = isEscalation
      ? `No reply for ${ESCALATE_AFTER_HOURS}h`
      : `${decision.overdueDays} day${decision.overdueDays === 1 ? "" : "s"} past its needed-by date`;

    if (recipients.size > 0) {
      void createNotificationsForUsers([...recipients], {
        type: "query_chase",
        title: headline,
        body: `${label} — ${reason}`,
        url: `/queries?open=${q.id}`,
        entityType: def.auditEntityType,
        entityId: q.entity_id,
      });
    }

    if (alertSet.size > 0) {
      void emailQueryEvent({
        recipients: [...alertSet].map((id) => ({ email: byId.get(id)?.email ?? null })),
        headline,
        entityLabel: label,
        message: reason,
        queryId: q.id,
      });
    }

    // WhatsApp is the escalation tier only — a due-date nudge doesn't warrant
    // interrupting someone on their phone.
    if (isEscalation && WA_TEMPLATE_QUERY_ESCALATION) {
      const phones = [
        ...new Set([...alertSet].map((id) => byId.get(id)?.phone).filter((p): p is string => !!p)),
      ];
      if (phones.length > 0) {
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
        whatsappSent++;
      }
    }

    // Typed timeline event, so a chase shows up in the thread rather than
    // silently changing who is being paged. Deliberately no audit_trail row —
    // an automated reminder isn't a state change to the record. See
    // logQueryAudit in src/lib/queries/server.ts.
    await supabase.from("query_messages").insert({
      query_id: q.id,
      event_type: "nudged",
      body: null,
      created_by: q.created_by,
    });

    // last_nudged_at drives the daily cooldown for both kinds; escalated_at
    // additionally marks this stretch of silence as already escalated, and is
    // cleared whenever a new message lands.
    const stamp: Record<string, string> = { last_nudged_at: now.toISOString() };
    if (isEscalation) stamp.escalated_at = now.toISOString();
    await supabase.from("queries").update(stamp).eq("id", q.id);

    if (isEscalation) escalated++;
    else nudged++;
  }

  return NextResponse.json({
    checked: rows.length,
    nudged,
    escalated,
    whatsapp_sent: whatsappSent,
    whatsapp_template_configured: !!WA_TEMPLATE_QUERY_ESCALATION,
  });
}

export const GET = withCronHealth("cron/query-escalation", handler);
