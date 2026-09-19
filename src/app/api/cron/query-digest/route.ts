import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendWhatsApp } from "@/lib/whatsapp";
import { queryEntityDef } from "@/lib/queries/registry";
import { loadEntitySummaries, entityKey, entityLabel } from "@/lib/queries/server";
import { emailQueryDigest, queryUrl } from "@/lib/queries/notify";
import type { QueryDigestEmailItem } from "@/lib/queries/digest-email";
import { buildQueryDigest, DIGEST_LOOKBACK_HOURS, type DigestCandidate, type DigestThread } from "@/lib/queries/digest";
import { ESCALATE_AFTER_HOURS } from "@/lib/queries/chase";
import { USER_ROLE_LABELS } from "@/lib/constants";
import { QUERY_KIND_LABELS, type QueryKind, type QueryTargeting } from "@/lib/queries/types";

import { withCronHealth } from "@/lib/cron-ping";

/**
 * GET /api/cron/query-digest
 *
 * The one place queries send email. Once a day, each person gets a single
 * digest of everything on their plate: new queries, replies, resolutions, and
 * the chase — overdue past a needed_by date, or silent for 48h.
 *
 * This replaces a real-time email on every reply plus a per-thread chase email
 * every six hours. The routing and timing rules are unchanged (see
 * buildQueryDigest in src/lib/queries/digest.ts); only the number of emails
 * they turn into is.
 *
 * In-app notifications still fire in real time from fanOutQueryEvent — those
 * are not emailed.
 *
 * Chase bookkeeping is unchanged: a thread that was chased gets a typed
 * "nudged" timeline event and its last_nudged_at / escalated_at stamps, so the
 * daily cooldown and once-per-silence escalation still hold. Those stamps are
 * only written once someone the thread reached actually received the email —
 * otherwise a failed send would quietly cost a day's reminders.
 *
 * WhatsApp is still the escalation tier only, and only once
 * MSG91_WA_TEMPLATE_BILLING_QUERY_ESCALATION is set (it needs MSG91 approval;
 * until then the cron degrades to email). The env var keeps its original
 * BILLING_ name so setting it needs no code change.
 */
export const dynamic = "force-dynamic";

const WA_TEMPLATE_QUERY_ESCALATION =
  process.env.MSG91_WA_TEMPLATE_BILLING_QUERY_ESCALATION?.trim() || undefined;

interface ThreadRow {
  id: string;
  entity_type: string;
  entity_id: string;
  created_by: string;
  created_at: string;
  status: "open" | "resolved";
  kind: QueryKind;
  needed_by: string | null;
  escalated_at: string | null;
  last_nudged_at: string | null;
  audience: QueryTargeting["audience"];
  audience_roles: string[];
  audience_user_ids: string[];
  messages: Array<{ id: string; created_by: string; created_at: string; event_type: string; body: string | null }>;
}

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date();
  const windowStart = new Date(now.getTime() - DIGEST_LOOKBACK_HOURS * 3_600_000).toISOString();

  // Every open thread (the chase looks at all of them), plus anything resolved
  // inside the window so the asker hears their question was answered.
  const { data, error } = await supabase
    .from("queries")
    .select(`
      id, entity_type, entity_id, created_by, created_at, status, kind, needed_by,
      escalated_at, last_nudged_at, audience, audience_roles, audience_user_ids,
      messages:query_messages(id, created_by, created_at, event_type, body)
    `)
    .or(`status.eq.open,resolved_at.gte.${windowStart}`);

  if (error) {
    console.error("[query-digest] load failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const threads: DigestThread[] = ((data ?? []) as unknown as ThreadRow[]).map((q) => ({
    id: q.id,
    entity_type: q.entity_type,
    entity_id: q.entity_id,
    created_by: q.created_by,
    created_at: q.created_at,
    status: q.status,
    kind: q.kind,
    needed_by: q.needed_by,
    escalated_at: q.escalated_at,
    last_nudged_at: q.last_nudged_at,
    targeting: {
      audience: q.audience,
      audience_roles: q.audience_roles as QueryTargeting["audience_roles"],
      audience_user_ids: q.audience_user_ids,
    },
    messages: q.messages,
  }));

  const { data: users } = await supabase
    .from("users")
    .select("id, role, email, phone, is_active")
    .eq("is_active", true);
  const candidates = (users ?? []) as Array<DigestCandidate & { phone: string | null }>;
  const byId = new Map(candidates.map((u) => [u.id, u]));

  const digest = buildQueryDigest({ threads, candidates, now });

  const summaryRefs = new Map<string, { entity_type: string; entity_id: string }>();
  for (const items of digest.byRecipient.values()) {
    for (const item of items) {
      summaryRefs.set(item.queryId, { entity_type: item.entityType, entity_id: item.entityId });
    }
  }
  const summaries = await loadEntitySummaries(supabase, [...summaryRefs.values()]);

  // Askers are looked up separately from `candidates`: that list is active
  // users only, and someone who has since left still raised the query.
  const askerIds = [...new Set([...digest.byRecipient.values()].flatMap((items) => items.map((i) => i.askerId)))];
  const askers = new Map<string, string>();
  if (askerIds.length > 0) {
    const { data: askerRows } = await supabase.from("users").select("id, full_name, role").in("id", askerIds);
    for (const a of (askerRows ?? []) as Array<{ id: string; full_name: string | null; role: string }>) {
      if (a.full_name) askers.set(a.id, `${a.full_name} · ${USER_ROLE_LABELS[a.role] ?? a.role}`);
    }
  }

  // One email per person. Sequential on purpose: the list is a handful of
  // staff, and the mailer tries SMTP first — a burst of parallel sends buys
  // nothing and invites throttling.
  const emailed = new Set<string>();
  let emailsFailed = 0;
  for (const [personId, items] of digest.byRecipient) {
    const email = byId.get(personId)?.email;
    if (!email) continue;

    const emailItems: QueryDigestEmailItem[] = items.map((item) => {
      const def = queryEntityDef(item.entityType);
      return {
        url: queryUrl(item.queryId),
        entityLabel: def
          ? entityLabel(def, summaries.get(entityKey(item.entityType, item.entityId)) ?? null)
          : "(unknown record)",
        kindLabel: QUERY_KIND_LABELS[item.kind] ?? "Question",
        askedBy: askers.get(item.askerId) ?? null,
        badges: item.badges,
        awaitingYou: item.awaitingYou,
        latestReply: item.latestReply,
        neededBy: item.neededBy,
      };
    });

    if (await emailQueryDigest({ to: email, items: emailItems })) emailed.add(personId);
    else emailsFailed++;
  }

  let nudged = 0;
  let escalated = 0;
  let whatsappSent = 0;

  for (const chase of digest.chased) {
    const { thread } = chase;
    const reached = chase.recipientIds.some((id) => emailed.has(id));
    // Nobody reachable is not a failure to retry — nothing would ever land.
    // But if there were people to reach and every send failed, leave the stamps
    // alone so tomorrow's run chases again.
    if (chase.recipientIds.length > 0 && !reached) continue;

    const isEscalation = chase.kind === "escalate";

    if (isEscalation && WA_TEMPLATE_QUERY_ESCALATION) {
      const def = queryEntityDef(thread.entity_type);
      if (def) {
        const label = entityLabel(def, summaries.get(entityKey(thread.entity_type, thread.entity_id)) ?? null);
        const phones = [
          ...new Set(chase.recipientIds.map((id) => byId.get(id)?.phone).filter((p): p is string => !!p)),
        ];
        if (phones.length > 0) {
          await Promise.allSettled(
            phones.map((phone) =>
              sendWhatsApp({
                to: phone,
                template: WA_TEMPLATE_QUERY_ESCALATION,
                params: [label, `${ESCALATE_AFTER_HOURS}h`, queryUrl(thread.id)],
                entityType: def.auditEntityType,
                entityId: thread.entity_id,
              }),
            ),
          );
          whatsappSent++;
        }
      }
    }

    // Typed timeline event, so a chase shows up in the thread rather than
    // silently changing who is being paged. Deliberately no audit_trail row —
    // an automated reminder isn't a state change to the record. See
    // logQueryAudit in src/lib/queries/server.ts.
    await supabase.from("query_messages").insert({
      query_id: thread.id,
      event_type: "nudged",
      body: null,
      created_by: thread.created_by,
    });

    // last_nudged_at drives the daily cooldown for both kinds; escalated_at
    // additionally marks this stretch of silence as already escalated, and is
    // cleared whenever a new message lands.
    const stamp: Record<string, string> = { last_nudged_at: now.toISOString() };
    if (isEscalation) stamp.escalated_at = now.toISOString();
    await supabase.from("queries").update(stamp).eq("id", thread.id);

    if (isEscalation) escalated++;
    else nudged++;
  }

  return NextResponse.json({
    threads_checked: threads.length,
    digests_sent: emailed.size,
    digests_failed: emailsFailed,
    nudged,
    escalated,
    whatsapp_sent: whatsappSent,
    whatsapp_template_configured: !!WA_TEMPLATE_QUERY_ESCALATION,
  });
}

export const GET = withCronHealth("cron/query-digest", handler);
