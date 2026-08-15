import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/audit";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { emailBillingQueryEvent } from "@/lib/billing-queries-notify";
import { BILLING_QUERY_ROLES, BILLING_QUERY_ALERT_ROLES, isBillingQueryRole, resolveStatementSummary, STATEMENT_OWNER_SELECT } from "@/lib/billing-queries";

/**
 * POST /api/billing-queries/[id]/messages
 *
 * Add a reply to a query thread. Pass `resolve: true` to close the query
 * in the same action — the body becomes the resolution note (optional in
 * that case), mirroring the facility "resolve with a note" pattern.
 */
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase.from("users").select("id, role, full_name").eq("auth_id", user.id).maybeSingle();
  if (!dbUser) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!isBillingQueryRole(dbUser.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const payload = (await req.json().catch(() => ({}))) as { body?: string; resolve?: boolean };
  const messageBody = (payload.body ?? "").trim();
  const resolve = payload.resolve === true;

  if (!resolve && !messageBody) {
    return NextResponse.json({ error: "A message is required." }, { status: 400 });
  }

  const adminClient = await createAdminClient();

  const { data: existing, error: fetchErr } = await adminClient
    .from("billing_queries")
    .select("id, status, billing_statement_id, created_by")
    .eq("id", id)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "Query not found" }, { status: 404 });
  if (existing.status === "resolved" && !resolve) {
    return NextResponse.json({ error: "This query is resolved. Reopen it before replying." }, { status: 409 });
  }
  if (resolve && existing.created_by !== dbUser.id && dbUser.role !== "admin") {
    return NextResponse.json(
      { error: "Only the person who asked this question (or an admin) can mark it resolved." },
      { status: 403 },
    );
  }

  if (messageBody) {
    const { error: msgErr } = await adminClient.from("billing_query_messages").insert({
      query_id: id,
      event_type: "message",
      body: messageBody,
      created_by: dbUser.id,
    });
    if (msgErr) return NextResponse.json({ error: msgErr.message }, { status: 500 });
  }

  if (resolve) {
    const { error: updateErr } = await adminClient
      .from("billing_queries")
      .update({ status: "resolved", resolved_by: dbUser.id, resolved_at: new Date().toISOString() })
      .eq("id", id);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    await adminClient.from("billing_query_messages").insert({
      query_id: id,
      event_type: "resolved",
      body: messageBody || null,
      created_by: dbUser.id,
    });
  } else {
    // Touch updated_at so the thread resurfaces at the top of the list even
    // without a status change (trigger only fires on billing_queries rows
    // that are actually updated — a reply alone doesn't update this row, so
    // do it explicitly). Also clear escalated_at — new activity means the
    // silence the escalation cron flagged is over; if it goes quiet again
    // past the threshold, it's eligible to escalate again.
    await adminClient.from("billing_queries").update({ updated_at: new Date().toISOString(), escalated_at: null }).eq("id", id);
  }

  // Notify the other participants — everyone in the role set except whoever
  // just posted. Simple v1 broadcast, same reasoning as thread creation.
  const { data: recipients } = await adminClient
    .from("users")
    .select("id")
    .in("role", BILLING_QUERY_ROLES)
    .eq("is_active", true)
    .neq("id", dbUser.id);

  if (recipients && recipients.length > 0) {
    void createNotificationsForUsers(recipients.map((r) => r.id), {
      type: "billing_query_reply",
      title: resolve ? "Billing query resolved" : "Billing query reply",
      body: `${dbUser.full_name}: ${(messageBody || "Marked resolved").slice(0, 140)}`,
      url: `/billing-queries?open=${id}`,
      entityType: "billing_statement",
      entityId: existing.billing_statement_id,
    });

    const { data: emailRecipients } = await adminClient
      .from("users")
      .select("email")
      .in("role", BILLING_QUERY_ALERT_ROLES)
      .eq("is_active", true)
      .neq("id", dbUser.id);
    const { data: statementForEmail } = await adminClient
      .from("billing_statements")
      .select(STATEMENT_OWNER_SELECT)
      .eq("id", existing.billing_statement_id)
      .maybeSingle();
    const summary = statementForEmail
      ? resolveStatementSummary(statementForEmail as unknown as Parameters<typeof resolveStatementSummary>[0])
      : null;
    void emailBillingQueryEvent({
      recipients: emailRecipients ?? [],
      headline: resolve ? "Billing query resolved" : "Billing query reply",
      statementLabel: summary
        ? `${summary.party_name} · ${summary.context_label} · ${summary.statement_number ?? ""}`
        : "Billing statement",
      message: `${dbUser.full_name}: ${messageBody || "Marked resolved"}`,
      queryId: id,
    });
  }

  void logAudit(adminClient, {
    entityType: "billing_statement",
    entityId: existing.billing_statement_id,
    action: "update",
    performedBy: dbUser.id,
    changes: resolve
      ? { billing_query_status: { old: "open", new: "resolved" } }
      : { billing_query_reply: { old: null, new: messageBody.slice(0, 200) } },
  });

  return NextResponse.json({ ok: true });
}
