import { createAdminClient } from "@/lib/supabase/server";
import { sendPushToUsers } from "@/lib/push";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";

export const IT_PRIMARY_EMAIL = "techsupport@theworkvill.com";
export const IT_SECONDARY_EMAIL = "it@theworkvilla.com";

export const IT_NOTIFY_EMAILS = [IT_PRIMARY_EMAIL, IT_SECONDARY_EMAIL];

/**
 * Returns the primary IT assignee's user row (id + full_name) or null.
 * Used by the issue creation route to auto-assign IT-scoped tickets.
 */
export async function getItPrimaryAssignee(): Promise<{ id: string; full_name: string } | null> {
  const supabase = await createAdminClient();
  const { data } = await supabase
    .from("users")
    .select("id, full_name")
    .eq("email", IT_PRIMARY_EMAIL)
    .eq("is_active", true)
    .single();
  return data ?? null;
}

async function getItTeamUserIds(): Promise<string[]> {
  const supabase = await createAdminClient();
  const { data } = await supabase
    .from("users")
    .select("id")
    .in("email", IT_NOTIFY_EMAILS)
    .eq("is_active", true);
  return (data ?? []).map((u) => u.id);
}

async function getUserEmailById(userId: string): Promise<string | null> {
  const supabase = await createAdminClient();
  const { data } = await supabase
    .from("users")
    .select("email")
    .eq("id", userId)
    .single();
  return data?.email ?? null;
}

function issueUrl(issueId: string) {
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://app.theworkvilla.com";
  return `${base}/facility/issues/${issueId}`;
}

function emailHtml(params: {
  headline: string;
  issueNumber: string;
  title: string;
  detail: string;
  url: string;
}) {
  return `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#1a1a1a;margin:0 0 8px">${params.headline}</h2>
  <p style="margin:4px 0;color:#555"><strong>${params.issueNumber}</strong> — ${params.title}</p>
  <p style="margin:12px 0;color:#333">${params.detail}</p>
  <a href="${params.url}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;margin-top:8px">View Ticket</a>
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0" />
  <p style="font-size:12px;color:#999">The WorkVilla — Facility Support</p>
</div>`;
}

export type FacilityNotifyEvent =
  | { type: "created"; issueId: string; issueNumber: string; title: string; priority: string; reportedBy: string; assigneeId?: string }
  | { type: "status_changed"; issueId: string; issueNumber: string; title: string; from: string; to: string; actorName: string; assigneeId?: string }
  | { type: "assigned"; issueId: string; issueNumber: string; title: string; assigneeName: string | null; assigneeId?: string | null; actorName: string }
  | { type: "comment"; issueId: string; issueNumber: string; title: string; actorName: string; message: string; assigneeId?: string };

export async function notifyItTeam(event: FacilityNotifyEvent): Promise<void> {
  try {
    const itUserIds = await getItTeamUserIds();
    const url = issueUrl(event.issueId);

    // Build the full list of push recipient user IDs (IT team + assignee)
    const pushUserIds = [...itUserIds];
    const assigneeId = "assigneeId" in event ? event.assigneeId : undefined;
    if (assigneeId && !pushUserIds.includes(assigneeId)) {
      pushUserIds.push(assigneeId);
    }

    // Build the full list of email recipients (IT team + assignee email)
    const emailTo = [...IT_NOTIFY_EMAILS];
    if (assigneeId) {
      const assigneeEmail = await getUserEmailById(assigneeId);
      if (assigneeEmail && !emailTo.includes(assigneeEmail)) {
        emailTo.push(assigneeEmail);
      }
    }

    let pushTitle: string;
    let pushBody: string;
    let emailSubject: string;
    let emailHeadline: string;
    let emailDetail: string;

    switch (event.type) {
      case "created":
        pushTitle = `New Ticket: ${event.issueNumber}`;
        pushBody = `${event.title} [${event.priority.toUpperCase()}] — reported by ${event.reportedBy}`;
        emailSubject = `[${event.issueNumber}] New Ticket: ${event.title}`;
        emailHeadline = "New Facility Ticket Submitted";
        emailDetail = `<strong>Priority:</strong> ${event.priority.toUpperCase()}<br/><strong>Reported by:</strong> ${event.reportedBy}`;
        break;
      case "status_changed":
        pushTitle = `${event.issueNumber} — Status Update`;
        pushBody = `${event.from} → ${event.to} by ${event.actorName}`;
        emailSubject = `[${event.issueNumber}] Status: ${event.from} → ${event.to}`;
        emailHeadline = "Ticket Status Updated";
        emailDetail = `<strong>Status:</strong> ${event.from} → ${event.to}<br/><strong>Updated by:</strong> ${event.actorName}`;
        break;
      case "assigned":
        pushTitle = `${event.issueNumber} — Assignment`;
        pushBody = event.assigneeName
          ? `Assigned to ${event.assigneeName} by ${event.actorName}`
          : `Unassigned by ${event.actorName}`;
        emailSubject = `[${event.issueNumber}] ${event.assigneeName ? `Assigned to ${event.assigneeName}` : "Unassigned"}`;
        emailHeadline = "Ticket Assignment Changed";
        emailDetail = event.assigneeName
          ? `<strong>Assigned to:</strong> ${event.assigneeName}<br/><strong>By:</strong> ${event.actorName}`
          : `<strong>Unassigned</strong> by ${event.actorName}`;
        break;
      case "comment":
        pushTitle = `${event.issueNumber} — New Comment`;
        pushBody = `${event.actorName}: ${event.message.slice(0, 100)}`;
        emailSubject = `[${event.issueNumber}] Comment by ${event.actorName}`;
        emailHeadline = "New Comment on Ticket";
        emailDetail = `<strong>By:</strong> ${event.actorName}<br/><strong>Comment:</strong> ${event.message}`;
        break;
    }

    const pushPromise = pushUserIds.length > 0
      ? sendPushToUsers(pushUserIds, { title: pushTitle, body: pushBody, url, tag: `facility-${event.issueId}` })
      : Promise.resolve(0);

    const emailPromise = resend.emails.send({
      from: EMAIL_FROM,
      to: emailTo,
      subject: emailSubject,
      html: emailHtml({
        headline: emailHeadline,
        issueNumber: event.issueNumber,
        title: event.title,
        detail: emailDetail,
        url,
      }),
      replyTo: EMAIL_REPLY_TO,
    });

    const [pushResult, emailResult] = await Promise.allSettled([pushPromise, emailPromise]);
    if (pushResult.status === "rejected") {
      console.error("[facility-notify] push failed:", pushResult.reason);
    }
    if (emailResult.status === "rejected") {
      console.error("[facility-notify] email failed:", emailResult.reason);
    }
    console.log(`[facility-notify] ${event.type} — push to ${pushUserIds.length} users, email to ${emailTo.join(", ")}`);
  } catch (err) {
    console.error("[facility-notify] unexpected error:", err);
  }
}
