import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveAttachmentUrls } from "@/lib/communications-log";
import type { DepositHistoryItem } from "@/types";

export const dynamic = "force-dynamic";

const ALLOWED_ROLES = ["admin", "manager", "accounts", "sales_rep"];

/**
 * GET /api/proposals/[id]/deposit-history
 *
 * Every security deposit request made for a proposal, newest first, merged from:
 *   - communications_log (entity proposal) — emails, WhatsApps and PDF
 *     downloads made from the deposit dialog, with full content and CC list
 *   - receivable_reminder_sends (kind deposit) — manual and cron reminders
 *   - proposals.deposit_email_sent_at — a single "recipient not recorded" row
 *     for a request made before the log existed
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: dbUser } = await supabase
    .from("users").select("id, role").eq("auth_id", user.id).single();
  if (!dbUser || !ALLOWED_ROLES.includes(dbUser.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const [proposalRes, commRes, reminderRes] = await Promise.all([
    supabase.from("proposals").select("id, deposit_email_sent_at").eq("id", id).single(),
    // Only the deposit route logs against a proposal today; the subject/body
    // prefix keeps this list to deposit requests if other proposal sends are
    // logged later.
    supabase
      .from("communications_log")
      .select("*")
      .eq("entity_type", "proposal")
      .eq("entity_id", id)
      .or("subject.ilike.Security Deposit%,body.ilike.Security deposit%")
      .order("created_at", { ascending: false }),
    supabase
      .from("receivable_reminder_sends")
      .select("*")
      .eq("kind", "deposit")
      .eq("receivable_id", id)
      .order("created_at", { ascending: false }),
  ]);

  if (!proposalRes.data) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  if (commRes.error || reminderRes.error) {
    return NextResponse.json({ error: (commRes.error || reminderRes.error)?.message }, { status: 500 });
  }

  const commRows = await resolveAttachmentUrls(commRes.data || []);
  const reminderRows = reminderRes.data || [];

  const userIds = Array.from(new Set([
    ...commRows.map((r) => r.sent_by),
    ...reminderRows.map((r) => r.triggered_by_user_id),
  ].filter(Boolean))) as string[];
  const nameById = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users } = await supabase.from("users").select("id, full_name").in("id", userIds);
    (users || []).forEach((u) => nameById.set(u.id, u.full_name));
  }

  const items: DepositHistoryItem[] = [
    ...commRows.map((r): DepositHistoryItem => ({
      id: r.id,
      source: "request",
      channel: r.channel,
      status: r.status,
      recipient: r.recipient,
      cc: r.cc || [],
      created_at: r.created_at,
      sent_by_name: r.sent_by ? nameById.get(r.sent_by) || null : null,
      subject: r.subject,
      body: r.body,
      attachment_url: r.attachment_url,
      attachment_name: r.attachment_name,
      error_message: r.error_message,
      reminder_label: null,
    })),
    ...reminderRows.map((r): DepositHistoryItem => ({
      id: r.id,
      source: r.triggered_by === "cron" ? "auto_reminder" : "manual_reminder",
      channel: r.channel,
      status: r.status,
      recipient: r.recipient,
      cc: [],
      created_at: r.created_at,
      sent_by_name: r.triggered_by_user_id ? nameById.get(r.triggered_by_user_id) || null : null,
      subject: null,
      body: null,
      attachment_url: null,
      attachment_name: null,
      error_message: r.error,
      reminder_label: r.stage_label,
    })),
  ];

  // A request made before communications_log existed only left its timestamp.
  // Skip it once a logged request shares that moment (same send, now recorded).
  const legacySentAt = proposalRes.data.deposit_email_sent_at as string | null;
  if (legacySentAt) {
    const legacyMs = Date.parse(legacySentAt);
    const alreadyLogged = commRows.some((r) => Math.abs(Date.parse(r.created_at) - legacyMs) < 60_000);
    if (!alreadyLogged) {
      items.push({
        id: `legacy-${id}`,
        source: "legacy",
        channel: "email",
        status: "sent",
        recipient: null,
        cc: [],
        created_at: legacySentAt,
        sent_by_name: null,
        subject: null,
        body: null,
        attachment_url: null,
        attachment_name: null,
        error_message: null,
        reminder_label: null,
      });
    }
  }

  items.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return NextResponse.json({ data: items });
}
