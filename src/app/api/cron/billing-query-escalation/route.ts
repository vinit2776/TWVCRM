import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendWhatsApp } from "@/lib/whatsapp";
import { withCronHealth } from "@/lib/cron-ping";

import {
  BILLING_QUERY_ALERT_ROLES,
  resolveStatementSummary,
  STATEMENT_OWNER_SELECT,
} from "@/lib/billing-queries";

/**
 * GET /api/cron/billing-query-escalation
 *
 * Runs every 6 hours (see vercel.json). Escalates any open billing_queries
 * thread whose last message is 48h+ old with no reply, via WhatsApp — same
 * "silence past a threshold" pattern as facility-sla-check, adapted to
 * threads instead of tickets.
 *
 * WhatsApp needs an approved MSG91 template — set
 * MSG91_WA_TEMPLATE_BILLING_QUERY_ESCALATION once one exists. Until then
 * this cron still runs (and still stamps escalated_at, so nothing gets
 * silently skipped once the template is live) but the WhatsApp send is a
 * no-op, same graceful-degradation pattern as WA_TEMPLATE_ASSIGNED in
 * facility-notifications.ts.
 */
const ESCALATE_AFTER_HOURS = 48;

const WA_TEMPLATE_BILLING_QUERY_ESCALATION =
  process.env.MSG91_WA_TEMPLATE_BILLING_QUERY_ESCALATION?.trim() || undefined;

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - ESCALATE_AFTER_HOURS * 60 * 60 * 1000).toISOString();

  const { data: openQueries, error } = await supabase
    .from("billing_queries")
    .select(`
      id, billing_statement_id, created_by,
      created_by_user:users!billing_queries_created_by_fkey(full_name, role),
      statement:billing_statements!billing_queries_billing_statement_id_fkey(${STATEMENT_OWNER_SELECT}),
      messages:billing_query_messages(created_at, event_type, created_by, author:users!billing_query_messages_created_by_fkey(role))
    `)
    .eq("status", "open")
    .is("escalated_at", null);

  if (error) {
    console.error("[billing-query-escalation] query failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  type Row = {
    id: string;
    billing_statement_id: string;
    created_by: string;
    created_by_user: { full_name: string; role: string } | null;
    statement: Parameters<typeof resolveStatementSummary>[0];
    messages: Array<{ created_at: string; event_type: string; created_by: string; author: { role: string } | null }>;
  };

  const toEscalate = ((openQueries ?? []) as unknown as Row[]).filter((q) => {
    const sorted = [...q.messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const last = sorted[sorted.length - 1];
    if (!last) return false;
    return last.created_at < cutoff;
  });

  if (toEscalate.length === 0) {
    return NextResponse.json({ checked: openQueries?.length ?? 0, escalated: 0 });
  }

  const { data: waRecipients } = await supabase
    .from("users")
    .select("phone")
    .in("role", BILLING_QUERY_ALERT_ROLES)
    .eq("is_active", true)
    .not("phone", "is", null);
  const phones = [...new Set((waRecipients ?? []).map((r) => r.phone as string).filter(Boolean))];

  const base = (process.env.NEXT_PUBLIC_APP_URL || "https://twv-crm.vercel.app").trim();

  let sentCount = 0;
  for (const q of toEscalate) {
    const summary = resolveStatementSummary(q.statement);
    const label = `${summary.party_name} · ${summary.context_label}`;
    const url = `${base}/billing-queries?open=${q.id}`;

    if (WA_TEMPLATE_BILLING_QUERY_ESCALATION && phones.length > 0) {
      await Promise.allSettled(
        phones.map((phone) =>
          sendWhatsApp({
            to: phone,
            template: WA_TEMPLATE_BILLING_QUERY_ESCALATION,
            params: [label, `${ESCALATE_AFTER_HOURS}h`, url],
            entityType: "billing_statement",
            entityId: q.billing_statement_id,
          })
        )
      );
      sentCount++;
    }

    await supabase.from("billing_queries").update({ escalated_at: new Date().toISOString() }).eq("id", q.id);
  }

  return NextResponse.json({
    checked: openQueries?.length ?? 0,
    escalated: toEscalate.length,
    whatsapp_sent: sentCount,
    whatsapp_template_configured: !!WA_TEMPLATE_BILLING_QUERY_ESCALATION,
  });
}

export const GET = withCronHealth("cron/billing-query-escalation", handler);
