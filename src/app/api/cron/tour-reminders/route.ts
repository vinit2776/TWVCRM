import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { withCronHealth } from "@/lib/cron-ping";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { parseCronMode } from "@/lib/vo-renewal-reminders";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { sendWhatsApp } from "@/lib/whatsapp";
import {
  TOUR_REMINDER_MINUTES,
  TOUR_REMINDER_MODE_SETTING,
  TOUR_REMINDER_WA_TEMPLATE,
  minutesUntil,
  tourReminderRecipients,
  tourTimeText,
  type Person,
} from "@/lib/tour-reminder";

/**
 * Tour reminders: runs every 15 minutes. A tour that starts within the next 2 hours gets one
 * reminder, by WhatsApp and email, to the people running it: whoever booked it and whoever hosts it.
 * It NEVER contacts the customer.
 *
 * Only tours still ahead are considered (a tour that has started is never reminded), and each tour
 * is claimed with one atomic UPDATE (tour_reminder_sent_at IS NULL) BEFORE anything is sent, so
 * overlapping runs cannot send twice. A tour booked less than 2 hours ahead is reminded at the next run.
 *
 * MODE (app_settings.tour_reminder_mode):
 *   off      does nothing
 *   dry_run  (default; missing or unrecognised means this) reports what it WOULD send and sends
 *            nothing, claims nothing
 *   live     sends
 * ?dry_run=1 can turn a live run into a dry run; nothing in the URL can turn a dry run live.
 */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

type Row = {
  id: string;
  lead_id: string;
  meeting_start_at: string;
  meeting_location: string | null;
  creator: Person | null;
  host: Person | null;
  lead: { first_name: string; last_name: string | null; company: string | null; lead_number: number | string } | null;
};

const SELECT =
  "id, lead_id, meeting_start_at, meeting_location, creator:users!activities_created_by_fkey(id, full_name, email, phone), host:users!activities_tour_host_id_fkey(id, full_name, email, phone), lead:leads!activities_lead_id_fkey!inner(first_name, last_name, company, lead_number, status, archived_at)";

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const settings = await getCachedSettings(admin, [TOUR_REMINDER_MODE_SETTING]);
  let mode = parseCronMode(settings[TOUR_REMINDER_MODE_SETTING]);
  if (request.nextUrl.searchParams.get("dry_run") === "1" && mode === "live") mode = "dry_run";
  if (mode === "off") return NextResponse.json({ mode, message: "Switched off" });

  const now = new Date();
  const windowEnd = new Date(now.getTime() + TOUR_REMINDER_MINUTES * 60 * 1000);

  const due = () =>
    admin
      .from("activities")
      .select(SELECT)
      .eq("type", "tour")
      .is("tour_reminder_sent_at", null)
      .gt("meeting_start_at", now.toISOString())
      .lte("meeting_start_at", windowEnd.toISOString())
      .is("leads.archived_at", null)
      .not("leads.status", "in", "(lost,junk)");

  if (mode === "dry_run") {
    const { data, error } = await due().limit(200);
    if (error) {
      console.error("[tour-reminders] dry run failed", error.code, error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const rows = (data ?? []) as unknown as Row[];
    return NextResponse.json({
      mode,
      wouldRemind: rows.length,
      // Lead numbers and counts only: no names or contact details in a cron response.
      sample: rows.slice(0, 20).map((r) => ({
        lead: r.lead?.lead_number,
        inMinutes: minutesUntil(r.meeting_start_at, now),
        people: tourReminderRecipients(r.creator, r.host).length,
      })),
    });
  }

  // live: find, claim atomically, then send.
  const { data: found, error: findError } = await due().limit(200);
  if (findError) {
    console.error("[tour-reminders] find failed", findError.code, findError.message);
    return NextResponse.json({ error: findError.message }, { status: 500 });
  }
  const ids = ((found ?? []) as unknown as Row[]).map((r) => r.id);
  if (ids.length === 0) return NextResponse.json({ mode, message: "No tours due", claimed: 0 });

  const { data: claimed, error: claimError } = await admin
    .from("activities")
    .update({ tour_reminder_sent_at: now.toISOString() })
    .in("id", ids)
    .is("tour_reminder_sent_at", null)
    .select(SELECT);
  if (claimError) {
    console.error("[tour-reminders] claim failed", claimError.code, claimError.message);
    return NextResponse.json({ error: claimError.message }, { status: 500 });
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://twv-crm.vercel.app").trim();
  let emails = 0;
  let whatsapps = 0;

  for (const row of (claimed ?? []) as unknown as Row[]) {
    const lead = row.lead;
    const leadName = lead?.company || [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || "a lead";
    const when = tourTimeText(row.meeting_start_at);
    const where = row.meeting_location || "the centre";
    const url = `${appUrl}/leads/${row.lead_id}/activity`;

    for (const person of tourReminderRecipients(row.creator, row.host)) {
      const first = person.full_name?.split(" ")[0] || "there";
      if (person.email) {
        try {
          const { error } = await resend.emails.send({
            from: EMAIL_FROM,
            to: person.email,
            replyTo: EMAIL_REPLY_TO,
            subject: `Tour in 2 hours: ${leadName}, ${when}`,
            html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:16px">
              <p>Hi ${esc(first)},</p>
              <p>A tour starts in about 2 hours.</p>
              <p><b>${esc(leadName)}</b><br>${esc(when)} at ${esc(where)}</p>
              <p><a href="${url}">Open the lead</a></p></div>`,
          });
          if (error) console.error("[tour-reminders] email failed for activity", row.id, error.message);
          else emails++;
        } catch (err) {
          console.error("[tour-reminders] email threw for activity", row.id, err instanceof Error ? err.message : "unknown");
        }
      }
      if (person.phone) {
        try {
          const result = await sendWhatsApp({
            to: person.phone,
            template: TOUR_REMINDER_WA_TEMPLATE,
            params: [first, leadName, when, where, url],
            entityType: "lead",
            entityId: row.lead_id,
          });
          if (result.success) whatsapps++;
          else console.error("[tour-reminders] WhatsApp failed for activity", row.id, result.error);
        } catch (err) {
          console.error("[tour-reminders] WhatsApp threw for activity", row.id, err instanceof Error ? err.message : "unknown");
        }
      }
    }
  }

  return NextResponse.json({ mode, claimed: (claimed ?? []).length, emails, whatsapps });
}

export const GET = withCronHealth("cron/tour-reminders", handler);
