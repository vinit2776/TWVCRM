import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { queryEntityDef, type QueryEntityDef, type EntityRow } from "@/lib/queries/registry";
import { canSeeQuery, isAwaitingUser, validateTargeting, type Viewer } from "@/lib/queries/audience";
import {
  requireQueryUser,
  loadEntitySummaries,
  entityKey,
  fanOutQueryEvent,
  logQueryAudit,
} from "@/lib/queries/server";
import { parseQueryRequest, storeAttachments } from "@/lib/queries/attachments";
import { UploadValidationError } from "@/lib/uploads/normalize-upload-server";
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
  ),
  payment_report:query_payment_reports!query_payment_reports_query_id_fkey(amount, status)
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
  payment_report: { amount: number; status: string } | Array<{ amount: number; status: string }> | null;
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

/**
 * Why a thread is awaiting this viewer, not just that it is.
 *
 * A payment report always needs a bank-statement check, whoever raised it —
 * that's a different kind of work from a reply, so it gets its own reason
 * regardless of who's asking. Otherwise: if you're the one who raised the
 * thread, isAwaitingUser() only turns true once someone else has replied
 * (see its rule 2 — you can't be "awaiting yourself" the moment you ask), so
 * created_by === viewer here always means "you got an answer, go close it".
 * Anyone else it's awaiting is being asked to actually say something.
 */
function awaitingReasonFor(row: QueryRow, viewer: Viewer, isAwaiting: boolean): QueryListItem["awaiting_reason"] {
  if (!isAwaiting) return null;
  if (row.kind === "payment_reported") return "verify_payment";
  return row.created_by.id === viewer.id ? "awaiting_close" : "needs_answer";
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
  const isAwaiting = computeAwaiting(row, def, viewer);

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
    // The claim, not the contract. Without this a payment report card reads
    // "Acme Corp ₹59,000" — the contract's value — next to a ₹100 claim, and
    // the number a skim-reader takes away is the wrong one.
    reported_amount: (() => {
      const r = Array.isArray(row.payment_report) ? row.payment_report[0] : row.payment_report;
      return r ? Number(r.amount) : null;
    })(),
    last_message: last
      ? { body: last.body, event_type: last.event_type, created_at: last.created_at }
      : null,
    awaiting_viewer: isAwaiting,
    awaiting_reason: awaitingReasonFor(row, viewer, isAwaiting),
  };
}

const AWAITING_REASON_RANK: Record<NonNullable<QueryListItem["awaiting_reason"]>, number> = {
  // Someone is blocked on you actually saying something — the most urgent
  // bucket, since it's the only one where silence stalls another person.
  needs_answer: 0,
  // A claimed payment needs a bank-statement check — real work, but not a
  // reply someone is refreshing the page waiting on.
  verify_payment: 1,
  // You already have your answer; this is a click, not a thought.
  awaiting_close: 2,
};

/**
 * Reorders the "Awaiting you" tab by urgency instead of recency.
 *
 * Sorting by updated_at (every other tab's order) actively buries the thing
 * this tab exists to surface: a query nobody has touched in two weeks has an
 * old updated_at, so it sinks under whatever was merely replied-to five
 * minutes ago. Overdue threads come first (most-overdue first), then by what
 * kind of effort is being asked of the viewer, then oldest-idle-first within
 * each bucket — so a thread nobody has acted on for a while doesn't hide
 * behind fresher ones just because it's stale.
 */
function sortByUrgency(items: QueryListItem[], today: string): QueryListItem[] {
  return [...items].sort((a, b) => {
    const overdueA = !!a.needed_by && a.needed_by < today;
    const overdueB = !!b.needed_by && b.needed_by < today;
    if (overdueA !== overdueB) return overdueA ? -1 : 1;
    if (overdueA && overdueB) return (a.needed_by as string).localeCompare(b.needed_by as string);

    const rankA = a.awaiting_reason ? AWAITING_REASON_RANK[a.awaiting_reason] : 3;
    const rankB = b.awaiting_reason ? AWAITING_REASON_RANK[b.awaiting_reason] : 3;
    if (rankA !== rankB) return rankA - rankB;

    return a.updated_at.localeCompare(b.updated_at);
  });
}

/** Drop threads whose entity type this viewer's role isn't authorized on. */
function visibleRows(rows: QueryRow[], viewer: Viewer): Array<{ row: QueryRow; def: QueryEntityDef }> {
  return rows.flatMap((row) => {
    const def = queryEntityDef(row.entity_type);
    if (!def) return [];
    if (!canSeeQuery(def, viewer, row.created_by?.id)) return [];
    return [{ row, def }];
  });
}

/**
 * Errors here are returned, not swallowed into zeros.
 *
 * `data ?? []` / `count ?? 0` turn a failed query into a page of empty stat
 * cards at HTTP 200 — a broken Queries page that looks like an empty one. That
 * masked a real outage once: when 00421 renamed billing_queries → queries, the
 * pre-rename route's stats path kept answering 200 with 0/0/0 while the list
 * path honestly 500'd, which read as a tab-specific bug rather than the
 * route-wide schema mismatch it was.
 */
async function loadStats(
  admin: SupabaseClient,
  viewer: Viewer,
): Promise<{ stats: QueryStats } | { error: string }> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const today = new Date().toISOString().slice(0, 10);

  const [openRes, resolvedRes] = await Promise.all([
    admin.from("queries").select(THREAD_SELECT).eq("status", "open"),
    admin
      .from("queries")
      .select("id", { count: "exact", head: true })
      .eq("status", "resolved")
      .gte("resolved_at", weekAgo),
  ]);

  if (openRes.error) return { error: openRes.error.message };
  if (resolvedRes.error) return { error: resolvedRes.error.message };

  // A head:true count that fails reports no .error at all — PostgREST answers
  // 204 with no Content-Range and supabase-js leaves count null. So null is
  // the only failure signal this query has, and it's an unambiguous one: a
  // successful count: "exact" is always a number, 0 for an empty match.
  if (resolvedRes.count === null) {
    return { error: "Resolved-query count unavailable" };
  }

  const open = visibleRows((openRes.data ?? []) as unknown as QueryRow[], viewer);

  return {
    stats: {
      open: open.length,
      awaiting_you: open.filter(({ row, def }) => computeAwaiting(row, def, viewer)).length,
      overdue: open.filter(({ row }) => !!row.needed_by && row.needed_by < today).length,
      resolved_this_week: resolvedRes.count,
      new_24h: open.filter(({ row }) => row.created_at >= dayAgo).length,
    },
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
    const result = await loadStats(admin, viewer);
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: 500 });
    return NextResponse.json({ stats: result.stats });
  }

  const tab = (url.searchParams.get("tab") ?? "awaiting_me") as Tab;
  const cursor = url.searchParams.get("cursor");
  const moduleFilter = url.searchParams.get("module");
  // Filters by what a thread *is*, not which module it hangs off. Payment
  // reports hang off contracts, so a module chip files them next to
  // renewal-intent questions — accounts need a way to see just the money.
  const kindFilter = url.searchParams.get("kind");
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
  // "Awaiting you" and the role-visibility filter are both post-filters, so
  // over-fetch and slice after — otherwise a page of ten could come back
  // near-empty. Capped so a large backlog can't pull the whole table.
  const isPostFiltered = !entityId && tab === "awaiting_me";
  // This tab is re-sorted by urgency below, not updated_at (see
  // sortByUrgency) — an updated_at cursor would cut rows out of the SQL
  // fetch before that reordering ever happens, silently skipping items on
  // "Load more". The whole (capped) candidate set is already fetched fresh
  // every call here, so cursor is reinterpreted as a plain offset into the
  // sorted list instead.
  if (cursor && !isPostFiltered) q = q.lt("updated_at", cursor);
  const { data, error } = await q.limit(isPostFiltered ? 200 : PAGE_SIZE + 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as QueryRow[];
  let visible = visibleRows(rows, viewer);

  if (moduleFilter) visible = visible.filter(({ def }) => def.module === moduleFilter);
  if (kindFilter) visible = visible.filter(({ row }) => row.kind === kindFilter);

  const summaries = await loadEntitySummaries(
    admin,
    visible.map(({ row }) => ({ entity_type: row.entity_type, entity_id: row.entity_id })),
  );

  let items = visible.map(({ row, def }) =>
    toListItem(row, def, viewer, summaries.get(entityKey(row.entity_type, row.entity_id)) ?? null),
  );

  if (isPostFiltered) {
    items = sortByUrgency(items.filter((i) => i.awaiting_viewer), today);
    const offset = cursor ? Number(cursor) || 0 : 0;
    const slice = items.slice(offset, offset + PAGE_SIZE);
    return NextResponse.json({
      items: slice,
      next_cursor: offset + PAGE_SIZE < items.length ? String(offset + PAGE_SIZE) : null,
    });
  }

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

  let body: {
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
  let files: File[] = [];
  try {
    const parsed = await parseQueryRequest<typeof body>(req);
    body = parsed.meta ?? {};
    files = parsed.files;
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

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

  const { data: openingMessage, error: msgErr } = await admin
    .from("query_messages")
    .insert({
      query_id: created.id,
      event_type: "message",
      body: messageBody,
      created_by: dbUser.id,
    })
    .select("id")
    .single();
  if (msgErr) return NextResponse.json({ error: msgErr.message }, { status: 500 });

  const attachments = files.length
    ? await storeAttachments(admin, {
        queryId: created.id,
        messageId: openingMessage.id,
        files,
        uploadedBy: dbUser.id,
      })
    : { stored: 0, failed: [] as string[] };

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

  // The query is saved either way; a failed attachment is reported rather
  // than rolled back, so a dropped screenshot can't lose the question.
  return NextResponse.json(
    { id: created.id, attachments_failed: attachments.failed },
    { status: 201 },
  );
}
