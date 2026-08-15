import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { queryEntityDef, type QueryEntityDef, type EntityRow } from "@/lib/queries/registry";
import { isAwaitingUser, validateTargeting, type Viewer } from "@/lib/queries/audience";
import {
  requireQueryUser,
  loadEntitySummaries,
  entityKey,
  fanOutQueryEvent,
  logQueryAudit,
} from "@/lib/queries/server";
import type { QueryAuthor, QueryKind, QueryListItem, QueryStats } from "@/lib/queries/types";

/**
 * GET  /api/queries — list threads (tabbed), or ?stats=true for the header
 *                     counts, or ?entity_type=&entity_id= to scope to one
 *                     transaction (what the inline QueryButton uses).
 * POST /api/queries — raise a new thread.
 *
 * Replaces /api/billing-queries. See src/lib/queries/registry.ts for how an
 * entity type becomes queryable and audience.ts for the routing rules.
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 10;

type Tab = "awaiting_me" | "mine" | "open" | "overdue" | "resolved";

const THREAD_SELECT = `
  id, entity_type, entity_id, status, kind, audience, audience_roles, audience_user_ids,
  needed_by, created_at, updated_at, resolved_at,
  created_by:users!queries_created_by_fkey(id, full_name, role),
  resolved_by:users!queries_resolved_by_fkey(id, full_name, role),
  messages:query_messages(
    body, event_type, created_at, created_by,
    author:users!query_messages_created_by_fkey(id, full_name, role)
  )
`;

interface QueryRow {
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
  created_by: QueryAuthor;
  resolved_by: QueryAuthor | null;
  messages: Array<{
    body: string | null;
    event_type: "message" | "resolved" | "reopened" | "retargeted";
    created_at: string;
    created_by: string;
    author: QueryAuthor | null;
  }>;
}

function sortedMessages(row: QueryRow) {
  return [...row.messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

function targetingOf(row: QueryRow) {
  return {
    audience: row.audience,
    audience_roles: row.audience_roles as QueryListItem["audience_roles"],
    audience_user_ids: row.audience_user_ids,
  };
}

/** One definition of "awaiting", used by both the list and the stat cards. */
function computeAwaiting(row: QueryRow, def: QueryEntityDef, viewer: Viewer): boolean {
  const messages = sortedMessages(row);
  const last = messages[messages.length - 1] ?? null;
  return isAwaitingUser(
    {
      ...targetingOf(row),
      status: row.status,
      created_by_id: row.created_by.id,
      last_message_author_id: last?.created_by ?? null,
    },
    def,
    viewer,
  );
}

/** Shared row → list item mapping, so list and stats agree on "awaiting". */
function toListItem(
  row: QueryRow,
  def: QueryEntityDef,
  viewer: Viewer,
  entitySummary: QueryListItem["entity"],
): QueryListItem {
  const messages = sortedMessages(row);
  const last = messages[messages.length - 1] ?? null;

  return {
    id: row.id,
    entity_type: def.type,
    entity_id: row.entity_id,
    status: row.status,
    kind: row.kind,
    ...targetingOf(row),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at,
    needed_by: row.needed_by,
    entity: entitySummary,
    last_message: last
      ? { body: last.body, event_type: last.event_type, created_at: last.created_at }
      : null,
    awaiting_viewer: computeAwaiting(row, def, viewer),
  };
}

/** Drop threads whose entity type this viewer's role isn't authorized on. */
function visibleRows(rows: QueryRow[], viewer: Viewer): Array<{ row: QueryRow; def: QueryEntityDef }> {
  return rows.flatMap((row) => {
    const def = queryEntityDef(row.entity_type);
    if (!def) return [];
    if (!(def.roles as readonly string[]).includes(viewer.role)) return [];
    return [{ row, def }];
  });
}

async function loadStats(admin: SupabaseClient, viewer: Viewer): Promise<QueryStats> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  const [openRes, resolvedRes] = await Promise.all([
    admin.from("queries").select(THREAD_SELECT).eq("status", "open"),
    admin
      .from("queries")
      .select("id", { count: "exact", head: true })
      .eq("status", "resolved")
      .gte("resolved_at", weekAgo),
  ]);

  const open = visibleRows((openRes.data ?? []) as unknown as QueryRow[], viewer);

  return {
    open: open.length,
    awaiting_you: open.filter(({ row, def }) => computeAwaiting(row, def, viewer)).length,
    overdue: open.filter(({ row }) => !!row.needed_by && row.needed_by < today).length,
    resolved_this_week: resolvedRes.count ?? 0,
  };
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const auth = await requireQueryUser(supabase);
  if ("error" in auth) return auth.error;
  const viewer: Viewer = { id: auth.dbUser.id, role: auth.dbUser.role };

  const url = new URL(req.url);
  const admin = createAdminClient();

  if (url.searchParams.get("stats") === "true") {
    return NextResponse.json({ stats: await loadStats(admin, viewer) });
  }

  const tab = (url.searchParams.get("tab") ?? "awaiting_me") as Tab;
  const cursor = url.searchParams.get("cursor");
  const moduleFilter = url.searchParams.get("module");
  const entityType = url.searchParams.get("entity_type");
  const entityId = url.searchParams.get("entity_id");
  const today = new Date().toISOString().slice(0, 10);

  let q = admin.from("queries").select(THREAD_SELECT).order("updated_at", { ascending: false });

  // Scoped to one transaction (inline QueryButton) — no tab filtering, the
  // panel shows every thread on that record.
  if (entityType && entityId) {
    q = q.eq("entity_type", entityType).eq("entity_id", entityId);
  } else {
    if (tab === "resolved") q = q.eq("status", "resolved");
    else q = q.eq("status", "open");
    if (tab === "mine") q = q.eq("created_by", auth.dbUser.id);
    if (tab === "overdue") q = q.not("needed_by", "is", null).lt("needed_by", today);
  }
  if (cursor) q = q.lt("updated_at", cursor);

  // "Awaiting you" and the role-visibility filter are both post-filters, so
  // over-fetch and slice after — otherwise a page of ten could come back
  // near-empty. Capped so a large backlog can't pull the whole table.
  const isPostFiltered = !entityId && tab === "awaiting_me";
  const { data, error } = await q.limit(isPostFiltered ? 200 : PAGE_SIZE + 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as QueryRow[];
  let visible = visibleRows(rows, viewer);

  if (moduleFilter) visible = visible.filter(({ def }) => def.module === moduleFilter);

  const summaries = await loadEntitySummaries(
    admin,
    visible.map(({ row }) => ({ entity_type: row.entity_type, entity_id: row.entity_id })),
  );

  let items = visible.map(({ row, def }) =>
    toListItem(row, def, viewer, summaries.get(entityKey(row.entity_type, row.entity_id)) ?? null),
  );

  if (isPostFiltered) items = items.filter((i) => i.awaiting_viewer);

  const hasMore = items.length > PAGE_SIZE;
  const page = hasMore ? items.slice(0, PAGE_SIZE) : items;

  return NextResponse.json({
    items: page,
    next_cursor: hasMore ? page[page.length - 1].updated_at : null,
  });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const auth = await requireQueryUser(supabase);
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;

  const body = (await req.json().catch(() => ({}))) as {
    entity_type?: string;
    entity_id?: string;
    body?: string;
    kind?: string;
    template_key?: string;
    needed_by?: string;
    audience?: string;
    audience_roles?: unknown;
    audience_user_ids?: unknown;
  };

  const entityType = (body.entity_type ?? "").trim();
  const entityId = (body.entity_id ?? "").trim();
  const messageBody = (body.body ?? "").trim();
  const kind: QueryKind = body.kind === "action_needed" ? "action_needed" : "question";

  const def = queryEntityDef(entityType);
  if (!def) return NextResponse.json({ error: "Unknown entity type" }, { status: 400 });
  if (!entityId) return NextResponse.json({ error: "entity_id is required" }, { status: 400 });
  if (!messageBody) return NextResponse.json({ error: "A question is required" }, { status: 400 });
  if (!(def.roles as readonly string[]).includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const targeting = validateTargeting(body);
  if (!targeting.ok) return NextResponse.json({ error: targeting.error }, { status: 400 });

  const admin = createAdminClient();

  // Confirm the transaction exists before hanging a thread off it — the
  // polymorphic key has no FK to do this for us.
  const { data: entityRow, error: entityErr } = await admin
    .from(def.table)
    .select(def.select)
    .eq("id", entityId)
    .maybeSingle();
  if (entityErr) return NextResponse.json({ error: entityErr.message }, { status: 500 });
  if (!entityRow) return NextResponse.json({ error: `${def.label} not found` }, { status: 404 });

  const { data: created, error: insertErr } = await admin
    .from("queries")
    .insert({
      entity_type: def.type,
      entity_id: entityId,
      kind,
      created_by: dbUser.id,
      template_key: body.template_key ?? null,
      needed_by: body.needed_by || null,
      audience: targeting.value.audience,
      audience_roles: targeting.value.audience_roles,
      audience_user_ids: targeting.value.audience_user_ids,
    })
    .select("id")
    .single();
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  const { error: msgErr } = await admin.from("query_messages").insert({
    query_id: created.id,
    event_type: "message",
    body: messageBody,
    created_by: dbUser.id,
  });
  if (msgErr) return NextResponse.json({ error: msgErr.message }, { status: 500 });

  const summary = def.toSummary(entityRow as unknown as EntityRow);

  await fanOutQueryEvent(admin, {
    queryId: created.id,
    def,
    targeting: targeting.value,
    entitySummary: summary,
    entityId,
    author: dbUser,
    participantIds: [dbUser.id],
    headline: kind === "action_needed" ? "Action needed on a transaction" : "New query",
    message: messageBody,
    notificationType: "query_raised",
  });

  await logQueryAudit(admin, {
    action: "query_raised",
    def,
    entityRow: entityRow as unknown as EntityRow,
    fallbackEntityId: entityId,
    queryId: created.id,
    kind,
    targeting: targeting.value,
    performedBy: dbUser.id,
  });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
