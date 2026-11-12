import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { queryEntityDef } from "@/lib/queries/registry";
import {
  requireQueryUser,
  loadEntity,
  fanOutQueryEvent,
  logQueryAudit,
  threadParticipantIds,
} from "@/lib/queries/server";
import { parseQueryRequest, storeAttachments } from "@/lib/queries/attachments";
import { UploadValidationError } from "@/lib/uploads/normalize-upload-server";
import type { QueryKind, QueryThread } from "@/lib/queries/types";

/**
 * POST /api/queries/[id]/messages
 *
 * Reply to a thread. `resolve: true` closes it in the same action, with the
 * body becoming the resolution note — the one message that also lands in the
 * audit trail, since it's the outcome rather than conversation
 * (see logQueryAudit in src/lib/queries/server.ts).
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const auth = await requireQueryUser(supabase);
  if ("error" in auth) return auth.error;
  const { dbUser } = auth;

  let payload: { body?: string; resolve?: boolean };
  let files: File[] = [];
  try {
    const parsed = await parseQueryRequest<typeof payload>(req);
    payload = parsed.meta ?? {};
    files = parsed.files;
  } catch (err) {
    if (err instanceof UploadValidationError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  const messageBody = (payload.body ?? "").trim();
  const resolve = payload.resolve === true;

  // An attachment on its own is a legitimate reply — "here's the screenshot"
  // needs no prose.
  if (!resolve && !messageBody && files.length === 0) {
    return NextResponse.json({ error: "A message or an attachment is required." }, { status: 400 });
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

  if (existing.status === "resolved" && !resolve) {
    return NextResponse.json(
      { error: "This query is resolved. Reopen it before replying." },
      { status: 409 },
    );
  }

  // Only the asker decides their question was answered (#433). An admin can
  // override to stop a thread going stale when the asker has moved on.
  if (resolve && existing.created_by !== dbUser.id && dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only the person who asked this question (or an admin) can mark it resolved." },
      { status: 403 },
    );
  }

  let attachmentsFailed: string[] = [];

  if (messageBody || files.length > 0) {
    const { data: message, error: msgErr } = await admin
      .from("query_messages")
      .insert({
        query_id: id,
        event_type: "message",
        // An attachment-only reply still needs a body row; the constraint
        // requires non-empty text on 'message' events, so say what it is.
        body: messageBody || "(attachment)",
        created_by: dbUser.id,
      })
      .select("id")
      .single();
    if (msgErr) return NextResponse.json({ error: msgErr.message }, { status: 500 });

    if (files.length > 0) {
      const result = await storeAttachments(admin, {
        queryId: id,
        messageId: message.id,
        files,
        uploadedBy: dbUser.id,
      });
      attachmentsFailed = result.failed;
    }
  }

  if (resolve) {
    const { error: updateErr } = await admin
      .from("queries")
      .update({ status: "resolved", resolved_by: dbUser.id, resolved_at: new Date().toISOString() })
      .eq("id", id);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    await admin.from("query_messages").insert({
      query_id: id,
      event_type: "resolved",
      body: messageBody || null,
      created_by: dbUser.id,
    });
  } else {
    // Touch updated_at so the thread resurfaces at the top of the list — the
    // trigger only fires on rows that actually change, and a reply writes to
    // query_messages, not here. Clearing escalated_at means the silence the
    // escalation cron flagged is over; if it goes quiet again past the
    // threshold it becomes eligible to escalate afresh.
    await admin
      .from("queries")
      .update({ updated_at: new Date().toISOString(), escalated_at: null })
      .eq("id", id);
  }

  const targeting = {
    audience: existing.audience as QueryThread["audience"],
    audience_roles: existing.audience_roles as QueryThread["audience_roles"],
    audience_user_ids: existing.audience_user_ids as string[],
  };

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
    headline: resolve ? "Query resolved" : "Query reply",
    message: messageBody || "Marked resolved",
    notificationType: "query_reply",
  });

  // A plain reply writes no audit row — it already lives in query_messages,
  // and twelve of them would drown the state changes audit_trail exists for.
  if (resolve) {
    await logQueryAudit(admin, {
      action: "query_resolved",
      def,
      entityRow: entity?.row ?? null,
      fallbackEntityId: existing.entity_id,
      queryId: id,
      kind: existing.kind as QueryKind,
      targeting,
      performedBy: dbUser.id,
      resolutionNote: messageBody || null,
    });
  }

  return NextResponse.json({ ok: true, attachments_failed: attachmentsFailed });
}
