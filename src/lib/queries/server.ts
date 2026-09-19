import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { queryEntityDef, isQueryUser, type QueryEntityDef, type EntityRow } from "./registry";
import { resolveRecipients, type CandidateUser } from "./audience";
import type { QueryEntitySummary, QueryKind, QueryTargeting } from "./types";

/**
 * Server-side plumbing shared by the three /api/queries routes: auth, entity
 * summary resolution, audit logging and the notify/alert fan-out. Kept here
 * so the routes stay thin and the rules can't drift between create, reply
 * and reopen — the same drift that made the original billing-queries routes
 * each grow their own copy of the recipient query.
 */

export interface QueryUser {
  id: string;
  role: string;
  full_name: string;
}

export async function requireQueryUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<{ dbUser: QueryUser } | { error: NextResponse }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!dbUser) return { error: NextResponse.json({ error: "User not found" }, { status: 404 }) };
  if (!isQueryUser(dbUser.role)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { dbUser: dbUser as QueryUser };
}

export function entityKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/**
 * Batch-resolve display summaries for a mixed set of (entity_type, entity_id)
 * pairs — one query per entity type rather than one per row, so a page of ten
 * queries spanning three modules costs three round trips, not ten.
 *
 * Missing rows are simply absent from the map; callers render "transaction no
 * longer available" rather than failing, since (entity_type, entity_id) can't
 * carry a cascading FK.
 */
export async function loadEntitySummaries(
  admin: SupabaseClient,
  refs: Array<{ entity_type: string; entity_id: string }>,
): Promise<Map<string, QueryEntitySummary>> {
  const out = new Map<string, QueryEntitySummary>();

  const byType = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!queryEntityDef(ref.entity_type)) continue;
    const set = byType.get(ref.entity_type) ?? new Set<string>();
    set.add(ref.entity_id);
    byType.set(ref.entity_type, set);
  }

  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const def = queryEntityDef(type);
      if (!def) return;
      const { data, error } = await admin.from(def.table).select(def.select).in("id", [...ids]);
      if (error) {
        console.error(`[queries] summary load failed for ${type}:`, error.message);
        return;
      }
      for (const raw of (data ?? []) as unknown as EntityRow[]) {
        const summary = def.toSummary(raw);
        if (summary) out.set(entityKey(type, summary.id), summary);
      }
    }),
  );

  return out;
}

/**
 * Load one entity's raw row plus its summary.
 *
 * Both are returned because the raw row is what auditEntityId() needs: for
 * entity types with no AuditEntityType of their own the audit row hangs off
 * the parent (booking_gst_task → booking_id), which the display summary
 * doesn't carry. Callers that only need the summary can ignore `row`.
 */
export async function loadEntity(
  admin: SupabaseClient,
  entityType: string,
  entityId: string,
): Promise<{ def: QueryEntityDef; row: EntityRow | null; summary: QueryEntitySummary | null } | null> {
  const def = queryEntityDef(entityType);
  if (!def) return null;

  const { data, error } = await admin.from(def.table).select(def.select).eq("id", entityId).maybeSingle();
  if (error) {
    console.error(`[queries] entity load failed for ${entityType}:`, error.message);
    return { def, row: null, summary: null };
  }
  const row = (data ?? null) as unknown as EntityRow | null;
  return { def, row, summary: row ? def.toSummary(row) : null };
}

/** One-line context string for emails and notification bodies. */
export function entityLabel(def: QueryEntityDef, summary: QueryEntitySummary | null): string {
  if (!summary) return def.label;
  return [summary.title, summary.subtitle, summary.reference].filter(Boolean).join(" · ");
}

/**
 * Lifecycle-only audit logging.
 *
 * audit_trail feeds the admin audit log, the vendor bill timeline,
 * /api/users/[id]/activity and the weekly team digest. A twelve-message
 * thread writing twelve rows into all four would drown the state changes
 * those surfaces exist to show, so replies and auto-nudges deliberately
 * write no audit row — they already live in query_messages.
 *
 * `changes` carries a reference rather than the message text, with one
 * deliberate exception: a resolution note is the *outcome*, not conversation,
 * and someone reading a record's history months later needs to see it inline
 * rather than chase a query id. Capped at RESOLUTION_NOTE_LIMIT — anything
 * longer is a document and belongs in an attachment.
 */
export const RESOLUTION_NOTE_LIMIT = 500;

export async function logQueryAudit(
  admin: SupabaseClient,
  params: {
    action: "query_raised" | "query_resolved" | "query_reopened" | "query_retargeted";
    def: QueryEntityDef;
    entityRow: EntityRow | null;
    fallbackEntityId: string;
    queryId: string;
    kind: QueryKind;
    targeting: QueryTargeting;
    performedBy: string;
    resolutionNote?: string | null;
  },
) {
  const auditEntityId =
    (params.entityRow ? params.def.auditEntityId(params.entityRow) : null) ?? params.fallbackEntityId;

  const changes: Record<string, { old: unknown; new: unknown }> = {
    query_id: { old: null, new: params.queryId },
    kind: { old: null, new: params.kind },
    audience: {
      old: null,
      new:
        params.targeting.audience === "roles"
          ? params.targeting.audience_roles.join(", ")
          : params.targeting.audience === "users"
            ? `${params.targeting.audience_user_ids.length} person(s)`
            : "all",
    },
  };

  if (params.action === "query_resolved" && params.resolutionNote?.trim()) {
    changes.resolution_note = {
      old: null,
      new: params.resolutionNote.trim().slice(0, RESOLUTION_NOTE_LIMIT),
    };
  }

  void logAudit(admin, {
    entityType: params.def.auditEntityType,
    entityId: auditEntityId,
    action: params.action,
    performedBy: params.performedBy,
    changes,
  });
}

/**
 * Notify the audience in-app, in real time.
 *
 * Email is deliberately not sent from here: it used to go out on every event,
 * which flooded anyone paged across several modules. The paging set now gets
 * one daily digest instead — see src/app/api/cron/query-digest and
 * src/lib/queries/digest.ts. Both use resolveRecipients(), so the in-app and
 * email audiences can't disagree about who hears what.
 */
export async function fanOutQueryEvent(
  admin: SupabaseClient,
  params: {
    queryId: string;
    def: QueryEntityDef;
    targeting: QueryTargeting;
    entitySummary: QueryEntitySummary | null;
    entityId: string;
    author: QueryUser;
    participantIds: string[];
    headline: string;
    message: string;
    notificationType: string;
  },
) {
  const { data: candidates } = await admin
    .from("users")
    .select("id, role, email, is_active")
    .eq("is_active", true);

  const rows = (candidates ?? []) as Array<CandidateUser & { email: string | null }>;

  const { notify } = resolveRecipients({
    query: params.targeting,
    def: params.def,
    candidates: rows,
    participantIds: params.participantIds,
    authorId: params.author.id,
  });

  if (notify.length > 0) {
    void createNotificationsForUsers(notify, {
      type: params.notificationType,
      title: params.headline,
      body: `${params.author.full_name}: ${params.message.slice(0, 140)}`,
      url: `/queries?open=${params.queryId}`,
      entityType: params.def.auditEntityType,
      entityId: params.entityId,
    });
  }
}

/** Everyone who has posted in a thread, for keeping participants in the loop. */
export async function threadParticipantIds(admin: SupabaseClient, queryId: string): Promise<string[]> {
  const { data } = await admin.from("query_messages").select("created_by").eq("query_id", queryId);
  return [...new Set((data ?? []).map((m) => (m as { created_by: string }).created_by))];
}
