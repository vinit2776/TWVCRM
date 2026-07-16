import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { ACTIVITY_TYPE_LABELS } from "@/lib/constants";

/**
 * GET /api/cron/lead-reminder-digest
 *
 * Daily cron (9:00 AM IST) — emails each user a single list of their
 * lead follow-up reminders that are due today or overdue, so a reminder
 * keeps showing up daily until it's marked done or rescheduled.
 *
 * Replaces the old behavior of emailing immediately when a follow-up
 * was logged/rescheduled (see src/app/api/leads/[id]/activities/route.ts
 * and src/app/api/activities/[id]/route.ts).
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // "End of today" in IST, expressed as the equivalent UTC instant —
  // follow_up_date is a TIMESTAMPTZ so we compare against a precise boundary
  // rather than a date string.
  const istOffset = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const istNow = new Date(now.getTime() + istOffset);
  const todayIST = istNow.toISOString().slice(0, 10);
  const endOfTodayIST = new Date(
    new Date(`${todayIST}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000 - istOffset
  );

  const { data: dueActivities, error } = await admin
    .from("activities")
    .select(
      "id, lead_id, type, subject, follow_up_date, follow_up_notes, created_by, creator:users!activities_created_by_fkey(email, full_name), lead:leads!activities_lead_id_fkey(first_name, last_name, company)"
    )
    .eq("is_follow_up_done", false)
    .not("follow_up_date", "is", null)
    .lt("follow_up_date", endOfTodayIST.toISOString())
    .order("follow_up_date", { ascending: true });

  if (error) {
    console.error("[lead-reminder-digest] fetch error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!dueActivities || dueActivities.length === 0) {
    return NextResponse.json({ message: "No reminders due", count: 0 });
  }

  const appUrl = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "https://twv-crm.vercel.app"
  ).trim();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type ActivityRow = any;
  const byUser = new Map<string, { email: string; name: string; rows: ActivityRow[] }>();

  for (const row of dueActivities as ActivityRow[]) {
    const creator = row.creator;
    if (!creator?.email) continue;
    const key = row.created_by ?? creator.email;
    if (!byUser.has(key)) {
      byUser.set(key, { email: creator.email, name: creator.full_name ?? "there", rows: [] });
    }
    byUser.get(key)!.rows.push(row);
  }

  let emailed = 0;
  for (const { email, name, rows } of byUser.values()) {
    const tableRows = rows
      .map((row: ActivityRow) => {
        const lead = row.lead;
        const leadName =
          lead?.company ||
          [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") ||
          "Unknown lead";
        const followUpTime = new Date(row.follow_up_date).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          dateStyle: "medium",
          timeStyle: "short",
        });
        const leadUrl = `${appUrl}/leads/${row.lead_id}?tab=activities&highlight=${row.id}`;
        const typeLabel = ACTIVITY_TYPE_LABELS[row.type] ?? row.type;
        return `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;"><a href="${leadUrl}" style="color:#015E65;text-decoration:none;">${leadName}</a></td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${followUpTime}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${typeLabel}${row.subject ? ` — ${row.subject}` : ""}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${row.follow_up_notes ?? "—"}</td>
        </tr>`;
      })
      .join("");

    try {
      const { error: sendError } = await resend.emails.send({
        from: EMAIL_FROM,
        to: email,
        replyTo: EMAIL_REPLY_TO,
        subject: `Today's follow-up reminders — ${rows.length} lead(s)`,
        html: `
          <div style="font-family:sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
            <div style="background:#015E65;padding:20px 32px;">
              <h1 style="color:white;margin:0;font-size:20px;">Follow-up Reminders</h1>
              <p style="color:rgba(255,255,255,0.85);margin:4px 0 0;font-size:12px;">${todayIST} — ${rows.length} due or overdue</p>
            </div>
            <div style="padding:28px 32px;">
              <p style="color:#333;font-size:14px;">Hi ${name}, here are your pending lead follow-ups due today or earlier:</p>
              <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
                <tr style="background:#f0fdfa;">
                  <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #99f6e4;color:#015E65;font-size:11px;">Lead</th>
                  <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #99f6e4;color:#015E65;font-size:11px;">Due</th>
                  <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #99f6e4;color:#015E65;font-size:11px;">Activity</th>
                  <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #99f6e4;color:#015E65;font-size:11px;">Notes</th>
                </tr>
                ${tableRows}
              </table>
            </div>
            <div style="background:#015E65;padding:12px 32px;text-align:center;">
              <p style="color:#fff;margin:0;font-size:10px;">SREE DESIGN INFRASTRUCTURE PVT LTD | The WorkVilla</p>
            </div>
          </div>
        `,
      });
      if (sendError) {
        console.error(`[lead-reminder-digest] send failed for ${email}:`, sendError.message);
      } else {
        emailed++;
      }
    } catch (err) {
      console.error(`[lead-reminder-digest] send threw for ${email}:`, err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({
    message: `Sent reminder digest to ${emailed} user(s)`,
    users: emailed,
    reminders: dueActivities.length,
  });
}
