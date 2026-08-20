import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { queryEntityDef } from "@/lib/queries/registry";
import { isAwaitingUser, validateTargeting, type Viewer } from "@/lib/queries/audience";
import {
  requireQueryUser,
  loadEntity,
  fanOutQueryEvent,
  logQueryAudit,
  threadParticipantIds,
} from "@/lib/queries/server";
import { ATTACHMENT_SELECT } from "@/lib/queries/attachments";
import type { QueryAuthor, QueryKind, QueryMessage, QueryPaymentReport, QueryThread } from "@/lib/queries/types";

/**
 * GET   /api/queries/[id] — the full thread.
 * PATCH /api/queries/[id] — reopen a resolved thread, or re-target an open
 *                           one (both write a typed timeline event, so
 *                           neither changes who is on the hook silently).
 */
export const dynamic = "force-dynamic";

const THREAD_SELECT = `
  id, entity_type, entity_id, status, kind, audience, audience_roles, audience_user_ids,
  needed_by, created_at, updated_at, resolved_at, created_by,
  creator:users!queries_created_by_fkey(id, full_name, role),
  resolved_by:users!queries_resolved_by_fkey(id, full_name, role),
  messages:query_messages(
    id, event_type, body, created_at,
    created_by:users!query_messages_created_by_fkey(id, full_name, role),
    attachments:query_attachments!query_attachments_message_id_fkey(${ATTACHMENT_SELECT})
  ),
  payment_report:query_payment_reports!query_payment_reports_query_id_fkey(
    id, status, target_kind, amount, paid_on, payment_mode, payment_reference,
    payer_name, payer_differs, billing_payment_id, resolution_note,
    claimed_statement_id, reviewed_at, created_at,
    claimed_statement:billing_statements!query_payment_reports_claimed_statement_id_fkey(id, statement_number, gst_invoice_number),
    reviewed_by:users!query_payment_reports_reviewed_by_fkey(id, full_name, role),
    created_by:users!query_payment_reports_created_by_fkey(id, full_name, role)
  )
`;

interface ThreadRow {
  id: string;
  entity_type: string;
  entity_id: string;
  status: "open" | "resolved";
  kind: QueryKind;
  audience: "all" | "roles" | "users";
  audience_roles: string[];
  audience_user_ids: string[];
  needed_by: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  created_by: string;
  creator: QueryAuthor;
  resolved_by: QueryAuthor | null;
  messages: Array<QueryMessage>;
  payment_report: QueryPaymentReport | QueryPaymentReport[] | null;
}

async function fetchThread(
  admin: SupabaseClient,
  id: string,
  viewer: Viewer,
): Promise<{ status: number; error?: string; thread?: QueryThread }> {
  const { data, error } = await admin.from("queries").select(THREAD_SELECT).eq("id", id).maybeSingle();
  if (error) return { status: 500, error: error.message };
  if (!data) return { status: 404, error: "Query not found" };

  const row = data as unknown as ThreadRow;
  const def = queryEntityDef(row.entity_type);
  if (!def) return { status: 404, error: "Query not found" };
  if (!(def.roles as readonly string[]).includes(viewer.role)) {
    return { status: 403, error: "Forbidden" };
  }

  const messages = [...row.messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const last = messages[messages.length - 1] ?? null;

  const targeting = {
    audience: row.audience,
    audience_roles: row.audience_roles as QueryThread["audience_roles"],
    audience_user_ids: row.audience_user_ids,
  };

  // Resolve names for the "→ Priya S" pill in one place, so the client
  // doesn't need a second lookup to render who was asked.
  let audienceUsers: QueryAuthor[] = [];
  if (row.audience_user_ids.length > 0) {
    const { data: users } = await admin
      .from("users")
      .select("id, full_name, role")
      .in("id", row.audience_user_ids);
    audienceUsers = (users ?? []) as QueryAuthor[];
  }

  return {
    status: 200,
    thread: {
      id: row.id,
      entity_type: def.type,
      entity_id: row.entity_id,
      status: row.status,
      kind: row.kind,
      ...targeting,
      created_by: row.creator,
      created_at: row.created_at,
      updated_at: row.updated_at,
      resolved_by: row.resolved_by,
      resolved_at: row.resolved_at,
      needed_by: row.needed_by,
      entity: (await loadEntity(admin, row.entity_type, row.entity_id))?.summary ?? null,
      messages,
      audience_users: audienceUsers,
      // PostgREST returns a one-to-one embed as an object, but a one-to-many
      // as an array. query_payment_reports.query_id is UNIQUE, so this is
      // logically one-to-one — normalise either shape to a single value or
      // null rather than trusting which one comes back.
      payment_report: Array.isArray(row.payment_report)
        ? row.payment_report[0] ?? null
        : row.payment_report ?? null,
      awaiting_viewer: isAwaitingUser(
        {
          ...targeting,
          status: row.status,
          created_by_id: row.created_by,
          last_message_author_id: last?.created_by?.id ?? null,
        },
        def,
        viewer,
      ),
    },
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireQueryUser(supabase);
  if ("error" in auth) return auth.error;

  const admin = createAdminClient();
  const result = await fetchThread(admin, id, { id: auth.dbUser.id, role: auth.dbUser.role });
  if (!result.thread) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ thread: result.thread });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireQueryUser(supabase);
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;
  const viewer: Viewer = { id: dbUser.id, role: dbUser.role };

  const body = (await req.json().catch(() => ({}))) as {
    status?: string;
    audience?: string;
    audience_roles?: unknown;
    audience_user_ids?: unknown;
  };
  const wantsReopen = body.status === "open";
  const wantsRetarget = typeof body.audience === "string";

  if (!wantsReopen && !wantsRetarget) {
    return NextResponse.json(
      { error: "Pass status: 'open' to reopen, or an audience to re-target." },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from("queries")
    .select("id, status, kind, entity_type, entity_id, created_by, audience, audience_roles, audience_user_ids")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Query not found" }, { status: 404 });

  const def = queryEntityDef(existing.entity_type);
  if (!def) return NextResponse.json({ error: "Query not found" }, { status: 404 });
  if (!(def.roles as readonly string[]).includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let targeting = {
    audience: existing.audience as "all" | "roles" | "users",
    audience_roles: existing.audience_roles as QueryThread["audience_roles"],
    audience_user_ids: existing.audience_user_ids as string[],
  };

  if (wantsRetarget) {
    const parsed = validateTargeting(body);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    targeting = parsed.value;

    const { error: updateErr } = await admin
      .from("queries")
      .update({
        audience: targeting.audience,
        audience_roles: targeting.audience_roles,
        audience_user_ids: targeting.audience_user_ids,
        updated_at: new Date().toISOString(),
        // New audience means a fresh chance to answer before escalating.
        escalated_at: null,
      })
      .eq("id", id);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    await admin.from("query_messages").insert({
      query_id: id,
      event_type: "retargeted",
      body: null,
      created_by: dbUser.id,
    });
  }

  if (wantsReopen) {
    if (existing.status !== "resolved") {
      return NextResponse.json({ error: "Only a resolved query can be reopened." }, { status: 409 });
    }
    const { error: updateErr } = await admin
      .from("queries")
      .update({ status: "open", resolved_by: null, resolved_at: null, escalated_at: null })
      .eq("id", id);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    await admin.from("query_messages").insert({
      query_id: id,
      event_type: "reopened",
      body: null,
      created_by: dbUser.id,
    });
  }

  const [entity, participantIds] = await Promise.all([
    loadEntity(admin, existing.entity_type, existing.entity_id),
    threadParticipantIds(admin, id),
  ]);

  await fanOutQueryEvent(admin, {
    queryId: id,
    def,
    targeting,
    entitySummary: entity?.summary ?? null,
    entityId: existing.entity_id,
    author: dbUser,
    participantIds,
    headline: wantsReopen ? "Query reopened" : "Query re-assigned",
    message: wantsReopen ? "reopened this query" : "re-assigned this query",
    notificationType: "query_reply",
  });

  await logQueryAudit(admin, {
    action: wantsReopen ? "query_reopened" : "query_retargeted",
    def,
    entityRow: entity?.row ?? null,
    fallbackEntityId: existing.entity_id,
    queryId: id,
    kind: existing.kind as QueryKind,
    targeting,
    performedBy: dbUser.id,
  });

  const result = await fetchThread(admin, id, viewer);
  if (!result.thread) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ thread: result.thread });
}
