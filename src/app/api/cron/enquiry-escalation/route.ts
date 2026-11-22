import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { sendPushToUsers } from "@/lib/push";
import { withCronHealth } from "@/lib/cron-ping";
import { resend, EMAIL_FROM } from "@/lib/mailer";
import {
  ESCALATION_MAX_DAYS,
  firstTouchAt,
  parseEscalationMode,
  rungMessage,
  rungReached,
  rungRecipients,
  workingMinutesBetween,
  type EscalationRung,
} from "@/lib/enquiry-escalation";

const NOTIFY_TYPE = "enquiry_escalation";
const MAX_ENQUIRIES = 500;

/**
 * GET /api/cron/enquiry-escalation
 *
 * Every 10 minutes. An enquiry nobody has called, replied to or noted climbs a ladder on working
 * time (Mon to Sat, 9 to 7 IST): at 45 minutes the person who took it (or every sales person when
 * nobody has), at 90 the other sales people, at 3 hours the managers, who also get an email. Only the
 * highest rung reached is sent, once: dedupe is the notifications row (type enquiry_escalation,
 * entity_id = enquiry, same title). Only enquiries received after `enquiry_escalation_effective_from`
 * are ever chased.
 *
 * Staff only: in-app notification + push (+ email to managers on the last rung). It never messages a
 * customer. Mode `enquiry_escalation_mode`: off / dry_run (default: reports, writes and sends nothing)
 * / live. `?dry=1` forces a preview whatever the mode.
 */
async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = createAdminClient();

  const { data: settings } = await admin
    .from("app_settings")
    .select("key, value")
    .in("key", ["enquiry_escalation_mode", "enquiry_escalation_effective_from"]);
  const setting = (k: string) => (settings ?? []).find((s) => s.key === k)?.value as string | undefined;
  const mode = parseEscalationMode(setting("enquiry_escalation_mode"));
  if (mode === "off") return NextResponse.json({ mode, skipped: true });
  const dry = mode !== "live" || request.nextUrl.searchParams.get("dry") === "1";

  // No effective date means nothing is chased, never everything.
  const effectiveFrom = setting("enquiry_escalation_effective_from");
  if (!effectiveFrom) return NextResponse.json({ mode, skipped: "no effective date" });
  const since = new Date(Math.max(Date.parse(effectiveFrom), Date.now() - ESCALATION_MAX_DAYS * 24 * 60 * 60 * 1000)).toISOString();

  const { data: enquiries } = await admin
    .from("lead_enquiries")
    .select("id, reference, lead_id, claimed_by, received_at, payload, lead:leads!lead_enquiries_lead_id_fkey(first_name, last_name)")
    .is("resolved_at", null)
    .gte("received_at", since)
    .order("received_at", { ascending: true })
    .limit(MAX_ENQUIRIES);
  type Row = {
    id: string; reference: string; lead_id: string | null; claimed_by: string | null; received_at: string;
    payload: { name?: string; triage?: { kind?: string; reviewed?: unknown } } | null;
    lead: { first_name?: string | null; last_name?: string | null } | null;
  };
  // An enquiry the triage flagged "unsure" and nobody has confirmed is not yet known to be a real enquiry.
  const rows = ((enquiries ?? []) as unknown as Row[]).filter(
    (e) => !(e.payload?.triage?.kind === "unsure" && !e.payload.triage.reviewed) && e.payload?.triage?.kind !== "spam",
  );
  if (rows.length === 0) return NextResponse.json({ mode, dry, considered: 0, wouldNotify: [], notified: 0 });

  // What counts as a first touch: an update on the enquiry, or a call/note/email/meeting/tour on its lead.
  const ids = rows.map((e) => e.id);
  const leadIds = [...new Set(rows.map((e) => e.lead_id).filter((x): x is string => !!x))];
  const [{ data: updates }, { data: acts }] = await Promise.all([
    admin.from("enquiry_updates").select("enquiry_id, created_at").in("enquiry_id", ids),
    leadIds.length ? admin.from("activities").select("lead_id, subject, created_at").in("lead_id", leadIds).gte("created_at", since) : Promise.resolve({ data: [] }),
  ]);

  const [{ data: sales }, { data: managers }] = await Promise.all([
    admin.from("users").select("id, email").eq("role", "sales_rep").eq("is_active", true),
    admin.from("users").select("id, email").eq("role", "manager").eq("is_active", true),
  ]);
  const salesIds = (sales ?? []).map((u) => u.id as string);
  const managerIds = (managers ?? []).map((u) => u.id as string);
  const managerEmails = (managers ?? []).map((u) => u.email as string).filter(Boolean);

  const now = new Date();
  const planned: { e: Row; rung: EscalationRung; title: string; body: string; userIds: string[]; url: string }[] = [];
  for (const e of rows) {
    const events = [
      ...(updates ?? []).filter((u) => u.enquiry_id === e.id).map((u) => ({ at: u.created_at as string })),
      ...(acts ?? []).filter((a) => a.lead_id === e.lead_id).map((a) => ({ at: a.created_at as string, subject: a.subject as string | null })),
    ];
    if (firstTouchAt(e.received_at, events)) continue;
    const worked = workingMinutesBetween(e.received_at, now);
    const rung = rungReached(worked);
    if (!rung) continue;
    const name = `${e.lead?.first_name ?? ""} ${e.lead?.last_name === "-" ? "" : (e.lead?.last_name ?? "")}`.trim() || e.payload?.name || "A customer";
    const { title, body } = rungMessage(rung, e.reference, name, worked);
    const userIds = rungRecipients(rung, { ownerId: e.claimed_by, salesIds, managerIds });
    if (userIds.length === 0) continue;
    planned.push({ e, rung, title, body, userIds, url: e.lead_id ? `/leads/${e.lead_id}` : "/leads" });
  }

  const { data: existing } = await admin.from("notifications").select("entity_id, title").eq("type", NOTIFY_TYPE).in("entity_id", planned.map((p) => p.e.id));
  const todo = planned.filter((p) => !(existing ?? []).some((n) => n.entity_id === p.e.id && n.title === p.title));

  if (dry) {
    return NextResponse.json({ mode, dry: true, considered: rows.length, wouldNotify: todo.map((p) => ({ title: p.title, rung: p.rung, to: p.userIds.length })) });
  }

  let notified = 0;
  for (const p of todo) {
    await createNotificationsForUsers(p.userIds, { type: NOTIFY_TYPE, title: p.title, body: p.body, url: p.url, entityType: "lead_enquiry", entityId: p.e.id });
    await sendPushToUsers(p.userIds, { title: p.title, body: p.body, url: p.url, tag: `enquiry-escalation-${p.e.id}-${p.rung}` }).catch((err) =>
      console.error("[enquiry-escalation] push failed:", err),
    );
    if (p.rung === "manager" && managerEmails.length > 0) {
      const link = `${process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? ""}${p.url}`;
      await resend.emails
        .send({
          from: EMAIL_FROM,
          to: managerEmails,
          subject: p.title,
          html: `<p>${p.body}</p>${link ? `<p><a href="${link}">Open the lead</a></p>` : ""}`,
        })
        .catch((err) => console.error("[enquiry-escalation] email failed:", err));
    }
    notified += 1;
  }

  return NextResponse.json({ mode, dry: false, considered: rows.length, notified });
}

export const GET = withCronHealth("cron/enquiry-escalation", handler);
