import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { sendWhatsApp } from "@/lib/whatsapp";

const WINDOW_MINUTES = 10;

/**
 * GET /api/cron/lead-reminder-whatsapp
 *
 * Runs every 5 minutes — sends a WhatsApp nudge ~10 minutes before a lead
 * follow-up is due.
 *
 * Anti-spam design (this is a frequent cron, so double-sends are the main
 * risk):
 *   - Only matches follow_up_date STRICTLY IN THE FUTURE (now, now+10min].
 *     Overdue reminders are never picked up here — that's the daily email
 *     digest's job. Without this, the very first run after deploy would
 *     WhatsApp-blast every already-overdue reminder in the database at once.
 *   - Claims each row with a single atomic UPDATE ... WHERE
 *     followup_wa_reminder_sent_at IS NULL, done BEFORE sending. Two
 *     overlapping cron runs can both query the same candidates, but only
 *     one can win the claim on each row, so at most one message goes out
 *     per reminder. Rescheduling resets this column (see PATCH
 *     /api/activities/[id]) so a pushed-out follow-up gets exactly one
 *     fresh nudge at its new time.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  const now = new Date();
  const windowEnd = new Date(now.getTime() + WINDOW_MINUTES * 60 * 1000);

  const { data: candidates, error: fetchError } = await admin
    .from("activities")
    .select("id")
    .eq("is_follow_up_done", false)
    .is("followup_wa_reminder_sent_at", null)
    .gt("follow_up_date", now.toISOString())
    .lte("follow_up_date", windowEnd.toISOString());

  if (fetchError) {
    console.error("[lead-reminder-whatsapp] fetch error:", fetchError);
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ message: "No reminders due soon", count: 0 });
  }

  // Atomic claim: only rows still unclaimed (followup_wa_reminder_sent_at
  // still NULL) at the moment of this UPDATE are returned — guarantees
  // exactly one cron invocation "wins" each row even if runs overlap.
  const { data: claimed, error: claimError } = await admin
    .from("activities")
    .update({ followup_wa_reminder_sent_at: now.toISOString() })
    .in("id", candidates.map((c) => c.id))
    .is("followup_wa_reminder_sent_at", null)
    .select(
      "id, lead_id, follow_up_date, created_by, creator:users!activities_created_by_fkey(phone), lead:leads!activities_lead_id_fkey(first_name, last_name, company)"
    );

  if (claimError) {
    console.error("[lead-reminder-whatsapp] claim error:", claimError);
    return NextResponse.json({ error: claimError.message }, { status: 500 });
  }

  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ message: "All candidates already claimed", count: 0 });
  }

  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "https://twv-crm.vercel.app"
  ).trim();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type ClaimedRow = any;

  let sent = 0;
  let skippedNoPhone = 0;

  for (const row of claimed as ClaimedRow[]) {
    const phone = row.creator?.phone;
    if (!phone) {
      skippedNoPhone++;
      continue;
    }

    const lead = row.lead;
    const leadName =
      lead?.company ||
      [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") ||
      "this lead";
    const followUpTime = new Date(row.follow_up_date).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      dateStyle: "medium",
      timeStyle: "short",
    });
    const leadUrl = `${appUrl}/leads/${row.lead_id}?tab=activities&highlight=${row.id}`;

    try {
      const result = await sendWhatsApp({
        to: phone,
        template: "lead_followup_reminder",
        params: [leadName, followUpTime, leadUrl],
        entityType: "lead",
        entityId: row.lead_id,
      });
      if (result.success) {
        sent++;
      } else {
        console.error(`[lead-reminder-whatsapp] send failed for activity ${row.id}:`, result.error);
      }
    } catch (err) {
      console.error(`[lead-reminder-whatsapp] send threw for activity ${row.id}:`, err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({
    message: `Sent ${sent} WhatsApp reminder(s)`,
    sent,
    skippedNoPhone,
    claimed: claimed.length,
  });
}
