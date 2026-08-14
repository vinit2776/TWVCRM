import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import {
  isBillingQueryRole,
  isAwaitingViewer,
  resolveStatementSummary,
  STATEMENT_OWNER_SELECT,
  type BillingQueryThread,
  type BillingQueryAuthor,
} from "@/lib/billing-queries";

/**
 * GET /api/billing-queries/[id] — full thread (query + all messages).
 * PATCH /api/billing-queries/[id] — reopen a resolved query.
 */
export const dynamic = "force-dynamic";

async function requireBillingQueryUser(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const { data: dbUser } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).maybeSingle();
  if (!dbUser) return { error: NextResponse.json({ error: "User not found" }, { status: 404 }) } as const;
  if (!isBillingQueryRole(dbUser.role)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) } as const;
  return { dbUser } as const;
}

async function fetchThread(adminClient: Awaited<ReturnType<typeof createAdminClient>>, id: string, viewerRole: string) {
  const { data, error } = await adminClient
    .from("billing_queries")
    .select(`
      id, status, created_at, updated_at, resolved_at,
      created_by:users!billing_queries_created_by_fkey(id, full_name, role),
      resolved_by:users!billing_queries_resolved_by_fkey(id, full_name, role),
      statement:billing_statements!billing_queries_billing_statement_id_fkey(${STATEMENT_OWNER_SELECT}),
      messages:billing_query_messages(
        id, event_type, body, created_at,
        created_by:users!billing_query_messages_created_by_fkey(id, full_name, role)
      )
    `)
    .eq("id", id)
    .maybeSingle();

  if (error) return { error };
  if (!data) return { error: null, thread: null };

  type Row = {
    id: string;
    status: "open" | "resolved";
    created_at: string;
    updated_at: string;
    resolved_at: string | null;
    created_by: BillingQueryAuthor;
    resolved_by: BillingQueryAuthor | null;
    statement: Parameters<typeof resolveStatementSummary>[0];
    messages: Array<{ id: string; event_type: "message" | "resolved" | "reopened"; body: string | null; created_at: string; created_by: BillingQueryAuthor }>;
  };
  const row = data as unknown as Row;
  const messages = [...row.messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const last = messages[messages.length - 1] ?? null;

  const thread: BillingQueryThread = {
    id: row.id,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at,
    statement: resolveStatementSummary(row.statement),
    messages,
    awaiting_viewer: last ? isAwaitingViewer(row.status, last.created_by.role, viewerRole) : false,
  };
  return { error: null, thread };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireBillingQueryUser(supabase);
  if ("error" in auth) return auth.error;

  const adminClient = await createAdminClient();
  const { error, thread } = await fetchThread(adminClient, id, auth.dbUser.role);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!thread) return NextResponse.json({ error: "Query not found" }, { status: 404 });

  return NextResponse.json({ thread });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireBillingQueryUser(supabase);
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;

  const body = (await req.json().catch(() => ({}))) as { status?: string };
  if (body.status !== "open") {
    return NextResponse.json({ error: "Only status: 'open' (reopen) is supported here." }, { status: 400 });
  }

  const adminClient = await createAdminClient();
  const { data: existing, error: fetchErr } = await adminClient
    .from("billing_queries")
    .select("id, status, billing_statement_id, created_by")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Query not found" }, { status: 404 });
  if (existing.status !== "resolved") {
    return NextResponse.json({ error: "Only a resolved query can be reopened." }, { status: 409 });
  }

  const { error: updateErr } = await adminClient
    .from("billing_queries")
    .update({ status: "open", resolved_by: null, resolved_at: null })
    .eq("id", id);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  await adminClient.from("billing_query_messages").insert({
    query_id: id,
    event_type: "reopened",
    body: null,
    created_by: dbUser.id,
  });

  const { data: recipients } = await adminClient
    .from("users")
    .select("id")
    .eq("is_active", true)
    .neq("id", dbUser.id)
    .or(`id.eq.${existing.created_by}`);
  if (recipients && recipients.length > 0) {
    void createNotificationsForUsers(recipients.map((r) => r.id), {
      type: "billing_query_reply",
      title: "Billing query reopened",
      body: `${dbUser.full_name} reopened a billing query`,
      url: `/billing-queries?open=${id}`,
      entityType: "billing_statement",
      entityId: existing.billing_statement_id,
    });
  }

  void logAudit(adminClient, {
    entityType: "billing_statement",
    entityId: existing.billing_statement_id,
    action: "update",
    performedBy: dbUser.id,
    changes: { billing_query_status: { old: "resolved", new: "open" } },
  });

  const { error, thread } = await fetchThread(adminClient, id, dbUser.role);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ thread });
}
