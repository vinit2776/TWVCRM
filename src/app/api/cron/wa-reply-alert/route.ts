import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { sendPushToUsers } from "@/lib/push";
import { withCronHealth } from "@/lib/cron-ping";
import { loadWaitingReplies } from "@/lib/whatsapp-reply-queue";
import { REPLY_WAIT_AMBER_MINUTES, REPLY_WAIT_RED_MINUTES } from "@/lib/whatsapp-replies";

const NOTIFY_TYPE = "wa_reply_wait";

/**
 * GET /api/cron/wa-reply-alert
 *
 * Every 15 minutes. A customer who wrote on an enquiry someone has taken on, and has waited past the
 * amber threshold, nudges the person who took it; past the red threshold it also reaches admin and
 * manager. Each wait alerts once per level: dedupe is the notifications row (type wa_reply_wait,
 * entity_id = enquiry, same title) created after the wait began, so a customer who writes again after
 * a reply starts a fresh wait with fresh alerts. No schema change.
 *
 * Staff only: in-app notification + push. It never messages the customer.
 * ?dry=1 returns what would be sent without writing anything.
 */
async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dry = request.nextUrl.searchParams.get("dry") === "1";
  const admin = createAdminClient();

  const late = (await loadWaitingReplies(admin)).filter((w) => w.tone !== "ok");
  if (late.length === 0) return NextResponse.json({ late: 0, notified: 0 });

  const { data: existing } = await admin
    .from("notifications")
    .select("entity_id, title, created_at")
    .eq("type", NOTIFY_TYPE)
    .in("entity_id", late.map((w) => w.id));
  const alerted = (entityId: string, title: string, since: string) =>
    (existing ?? []).some((n) => n.entity_id === entityId && n.title === title && n.created_at >= since);

  const { data: managers } = await admin
    .from("users")
    .select("id")
    .in("role", ["admin", "manager"])
    .eq("is_active", true);
  const managerIds = (managers ?? []).map((u) => u.id as string);

  const planned = late
    .map((w) => {
      const red = w.tone === "red";
      const name =
        `${w.lead?.first_name ?? ""} ${w.lead?.last_name === "-" ? "" : (w.lead?.last_name ?? "")}`.trim() ||
        w.payload?.name ||
        "A customer";
      const minutes = red ? REPLY_WAIT_RED_MINUTES : REPLY_WAIT_AMBER_MINUTES;
      return {
        w,
        red,
        title: `${red ? "Reply overdue" : "Customer waiting"}: ${w.reference} — ${name}`,
        body: `Waiting over ${minutes / 60 >= 1 ? `${minutes / 60}h` : `${minutes}m`} for an answer on WhatsApp. Reply in the WhatsApp app, then tap Replied on the enquiry.`,
        userIds: red ? [...new Set([w.claimed_by, ...managerIds])] : [w.claimed_by],
      };
    })
    .filter((p) => !alerted(p.w.id, p.title, p.w.reply.waitingSince));

  if (dry) {
    return NextResponse.json({ dry: true, late: late.length, wouldNotify: planned.map((p) => p.title) });
  }

  for (const p of planned) {
    await createNotificationsForUsers(p.userIds, {
      type: NOTIFY_TYPE,
      title: p.title,
      body: p.body,
      url: p.w.lead_id ? `/leads/${p.w.lead_id}` : "/leads",
      entityType: "lead_enquiry",
      entityId: p.w.id,
    });
    await sendPushToUsers(p.userIds, {
      title: p.title,
      body: p.body,
      url: p.w.lead_id ? `/leads/${p.w.lead_id}` : "/leads",
      tag: `wa-reply-wait-${p.w.id}-${p.red ? "red" : "amber"}`,
    }).catch((err) => console.error("[wa-reply-alert] push failed:", err));
  }

  return NextResponse.json({ late: late.length, notified: planned.length });
}

export const GET = withCronHealth("cron/wa-reply-alert", handler);
