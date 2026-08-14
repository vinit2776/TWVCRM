import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import {
  BILLING_QUERY_ROLES,
  isBillingQueryRole,
  isAwaitingViewer,
  resolveStatementSummary,
  STATEMENT_OWNER_SELECT,
  type BillingQueryListItem,
  type BillingQueryAuthor,
} from "@/lib/billing-queries";

/**
 * GET /api/billing-queries
 * POST /api/billing-queries
 *
 * List (GET) and create (POST) accounts↔management query threads on billing
 * statements. See src/lib/billing-queries.ts for the shape rationale.
 */
export const dynamic = "force-dynamic";

const PAGE_SIZE = 10;

async function requireBillingQueryUser(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;

  const { data: dbUser } = await supabase
    .from("users")
    .select("id, role, full_name")
    .eq("auth_id", user.id)
    .maybeSingle();

  if (!dbUser) return { error: NextResponse.json({ error: "User not found" }, { status: 404 }) } as const;
  if (!isBillingQueryRole(dbUser.role)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) } as const;
  }
  return { dbUser } as const;
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const auth = await requireBillingQueryUser(supabase);
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;

  const url = new URL(req.url);
  const tab = (url.searchParams.get("tab") ?? "awaiting_me") as "awaiting_me" | "open" | "resolved" | "all";
  const cursor = url.searchParams.get("cursor"); // ISO timestamp of the last-seen updated_at
  const statementId = url.searchParams.get("statement_id"); // scope to one statement (Tally Inbox row panel)
  const statsOnly = url.searchParams.get("stats") === "true";

  const adminClient = await createAdminClient();

  if (statsOnly) {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [openCountRes, resolvedWeekRes, openWithLastMessageRes] = await Promise.all([
      adminClient.from("billing_queries").select("id", { count: "exact", head: true }).eq("status", "open"),
      adminClient.from("billing_queries").select("id", { count: "exact", head: true }).eq("status", "resolved").gte("resolved_at", weekAgo),
      adminClient
        .from("billing_queries")
        .select("id, created_by:users!billing_queries_created_by_fkey(role), messages:billing_query_messages(created_at, author:users!billing_query_messages_created_by_fkey(role))")
        .eq("status", "open"),
    ]);

    type StatsRow = { id: string; created_by: { role: string }; messages: Array<{ created_at: string; author: { role: string } | null }> };
    const awaitingCount = ((openWithLastMessageRes.data ?? []) as unknown as StatsRow[]).filter((r) => {
      const sorted = [...r.messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const last = sorted[sorted.length - 1];
      return isAwaitingViewer("open", last?.author?.role ?? r.created_by.role, dbUser.role);
    }).length;

    return NextResponse.json({
      stats: {
        open: openCountRes.count ?? 0,
        awaiting_you: awaitingCount,
        resolved_this_week: resolvedWeekRes.count ?? 0,
      },
    });
  }

  let query = adminClient
    .from("billing_queries")
    .select(`
      id, status, created_at, updated_at, resolved_at,
      created_by:users!billing_queries_created_by_fkey(id, full_name, role),
      resolved_by:users!billing_queries_resolved_by_fkey(id, full_name, role),
      statement:billing_statements!billing_queries_billing_statement_id_fkey(${STATEMENT_OWNER_SELECT}),
      messages:billing_query_messages(
        body, event_type, created_at,
        author:users!billing_query_messages_created_by_fkey(role)
      )
    `)
    .order("updated_at", { ascending: false })
    .limit(PAGE_SIZE + 1); // fetch one extra to know if there's a next page

  if (statementId) {
    query = query.eq("billing_statement_id", statementId);
  } else if (tab === "open" || tab === "awaiting_me") {
    query = query.eq("status", "open");
  } else if (tab === "resolved") {
    query = query.eq("status", "resolved");
  }
  if (cursor) {
    query = query.lt("updated_at", cursor);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = {
    id: string;
    status: "open" | "resolved";
    created_at: string;
    updated_at: string;
    resolved_at: string | null;
    created_by: BillingQueryAuthor;
    resolved_by: BillingQueryAuthor | null;
    statement: Parameters<typeof resolveStatementSummary>[0];
    messages: Array<{ body: string | null; event_type: "message" | "resolved" | "reopened"; created_at: string; author: { role: string } | null }>;
  };

  const rows = (data ?? []) as unknown as Row[];
  const hasMore = rows.length > PAGE_SIZE;
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  let items: BillingQueryListItem[] = page.map((r) => {
    const sortedMessages = [...r.messages].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const last = sortedMessages[sortedMessages.length - 1] ?? null;
    return {
      id: r.id,
      status: r.status,
      created_by: r.created_by,
      created_at: r.created_at,
      updated_at: r.updated_at,
      resolved_by: r.resolved_by,
      resolved_at: r.resolved_at,
      statement: resolveStatementSummary(r.statement),
      last_message: last ? { body: last.body, event_type: last.event_type, created_at: last.created_at } : null,
      awaiting_viewer: last
        ? isAwaitingViewer(r.status, last.author?.role ?? r.created_by.role, dbUser.role)
        : false,
    };
  });

  if (tab === "awaiting_me" && !statementId) {
    items = items.filter((i) => i.awaiting_viewer);
  }

  const nextCursor = hasMore ? page[page.length - 1].updated_at : null;

  return NextResponse.json({ items, next_cursor: nextCursor });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const auth = await requireBillingQueryUser(supabase);
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;

  const body = (await req.json().catch(() => ({}))) as { billing_statement_id?: string; body?: string };
  const statementId = (body.billing_statement_id ?? "").trim();
  const messageBody = (body.body ?? "").trim();

  if (!statementId) return NextResponse.json({ error: "billing_statement_id is required" }, { status: 400 });
  if (!messageBody) return NextResponse.json({ error: "A question is required" }, { status: 400 });

  const adminClient = await createAdminClient();

  const { data: statement, error: stmtErr } = await adminClient
    .from("billing_statements")
    .select("id")
    .eq("id", statementId)
    .maybeSingle();
  if (stmtErr) return NextResponse.json({ error: stmtErr.message }, { status: 500 });
  if (!statement) return NextResponse.json({ error: "Statement not found" }, { status: 404 });

  const { data: newQuery, error: insertErr } = await adminClient
    .from("billing_queries")
    .insert({ billing_statement_id: statementId, created_by: dbUser.id })
    .select("id")
    .single();
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  const { error: msgErr } = await adminClient.from("billing_query_messages").insert({
    query_id: newQuery.id,
    event_type: "message",
    body: messageBody,
    created_by: dbUser.id,
  });
  if (msgErr) return NextResponse.json({ error: msgErr.message }, { status: 500 });

  // Notify everyone who can respond, except the asker themselves. Kept
  // simple for v1 — broadcast to the whole role set rather than trying to
  // resolve "the one sales_rep on this deal" (see isAwaitingViewer's doc
  // comment for the same reasoning).
  const { data: recipients } = await adminClient
    .from("users")
    .select("id")
    .in("role", BILLING_QUERY_ROLES)
    .eq("is_active", true)
    .neq("id", dbUser.id);

  if (recipients && recipients.length > 0) {
    void createNotificationsForUsers(
      recipients.map((r) => r.id),
      {
        type: "billing_query",
        title: "New billing query",
        body: `${dbUser.full_name}: ${messageBody.slice(0, 140)}`,
        url: `/billing-queries?open=${newQuery.id}`,
        entityType: "billing_statement",
        entityId: statementId,
      },
    );
  }

  void logAudit(adminClient, {
    entityType: "billing_statement",
    entityId: statementId,
    action: "update",
    performedBy: dbUser.id,
    changes: { billing_query_raised: { old: null, new: messageBody.slice(0, 200) } },
  });

  return NextResponse.json({ id: newQuery.id }, { status: 201 });
}
