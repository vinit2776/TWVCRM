import { createAdminClient } from "@/lib/supabase/server";
import { sendPushToUsers } from "@/lib/push";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";

type IssueRef = {
  id: string;
  category_id?: string | null;
  assigned_to?: string | null;
  issue_number: string;
  title: string;
};

export type FacilityNotifyEvent =
  | { type: "created"; priority: string; reportedBy: string }
  | { type: "status_changed"; from: string; to: string; actorName: string }
  | { type: "assigned"; assigneeName: string | null; actorName: string }
  | { type: "comment"; actorName: string; message: string };

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

/**
 * Notify the assigned technician, backup CC, and collaborators about an issue event.
 * Falls back to all admin users if the issue has no assignee and no backup.
 */
export async function notifyIssueAssignee(issue: IssueRef, event: FacilityNotifyEvent): Promise<void> {
  try {
    const supabase = createAdminClient();
    const url = issueUrl(issue.id);

    // Look up backup assignee from category (one extra query, fire-and-forget context)
    let backupAssigneeId: string | null = null;
    if (issue.category_id) {
      const { data: cat } = await supabase
        .from("facility_asset_categories")
        .select("backup_assignee_id")
        .eq("id", issue.category_id)
        .single();
      backupAssigneeId = cat?.backup_assignee_id ?? null;
    }

    // Fetch collaborators
    const { data: collabs } = await supabase
      .from("facility_issue_collaborators")
      .select("user_id")
      .eq("issue_id", issue.id);
    const collabUserIds = (collabs ?? []).map((c) => c.user_id as string);

    // Build recipient user ID set
    const recipientIds: string[] = [];
    if (issue.assigned_to) recipientIds.push(issue.assigned_to);
    if (backupAssigneeId && !recipientIds.includes(backupAssigneeId)) {
      recipientIds.push(backupAssigneeId);
    }
    for (const cid of collabUserIds) {
      if (!recipientIds.includes(cid)) recipientIds.push(cid);
    }

    // Fetch emails for all recipients
    let pushUserIds: string[];
    let emailTo: string[];

    if (recipientIds.length === 0) {
      // No assignee, no backup, no collaborators — alert all admins
      const { data: admins } = await supabase
        .from("users")
        .select("id, email")
        .eq("role", "admin")
        .eq("is_active", true);
      pushUserIds = (admins ?? []).map((a) => a.id as string);
      emailTo = (admins ?? []).map((a) => a.email as string).filter(Boolean);
    } else {
      pushUserIds = recipientIds;
      const { data: userRows } = await supabase
        .from("users")
        .select("id, email")
        .in("id", recipientIds);
      emailTo = (userRows ?? []).map((u) => u.email as string).filter(Boolean);
    }

    if (pushUserIds.length === 0) return;

    let pushTitle: string;
    let pushBody: string;
    let emailSubject: string;
    let emailHeadline: string;
    let emailDetail: string;

    switch (event.type) {
      case "created":
        pushTitle = `New Ticket: ${issue.issue_number}`;
        pushBody = `${issue.title} [${event.priority.toUpperCase()}] — reported by ${event.reportedBy}`;
        emailSubject = `[${issue.issue_number}] New Ticket: ${issue.title}`;
        emailHeadline = "New Facility Ticket Submitted";
        emailDetail = `<strong>Priority:</strong> ${event.priority.toUpperCase()}<br/><strong>Reported by:</strong> ${event.reportedBy}`;
        break;
      case "status_changed":
        pushTitle = `${issue.issue_number} — Status Update`;
        pushBody = `${event.from} → ${event.to} by ${event.actorName}`;
        emailSubject = `[${issue.issue_number}] Status: ${event.from} → ${event.to}`;
        emailHeadline = "Ticket Status Updated";
        emailDetail = `<strong>Status:</strong> ${event.from} → ${event.to}<br/><strong>Updated by:</strong> ${event.actorName}`;
        break;
      case "assigned":
        pushTitle = `${issue.issue_number} — Assignment`;
        pushBody = event.assigneeName
          ? `Assigned to ${event.assigneeName} by ${event.actorName}`
          : `Unassigned by ${event.actorName}`;
        emailSubject = `[${issue.issue_number}] ${event.assigneeName ? `Assigned to ${event.assigneeName}` : "Unassigned"}`;
        emailHeadline = "Ticket Assignment Changed";
        emailDetail = event.assigneeName
          ? `<strong>Assigned to:</strong> ${event.assigneeName}<br/><strong>By:</strong> ${event.actorName}`
          : `<strong>Unassigned</strong> by ${event.actorName}`;
        break;
      case "comment":
        pushTitle = `${issue.issue_number} — New Comment`;
        pushBody = `${event.actorName}: ${event.message.slice(0, 100)}`;
        emailSubject = `[${issue.issue_number}] Comment by ${event.actorName}`;
        emailHeadline = "New Comment on Ticket";
        emailDetail = `<strong>By:</strong> ${event.actorName}<br/><strong>Comment:</strong> ${event.message}`;
        break;
    }

    const issuePath = `/facility/issues/${issue.id}`;

    const [pushResult, emailResult, inAppResult] = await Promise.allSettled([
      sendPushToUsers(pushUserIds, { title: pushTitle, body: pushBody, url, tag: `facility-${issue.id}` }),
      resend.emails.send({
        from: EMAIL_FROM,
        to: emailTo,
        subject: emailSubject,
        html: emailHtml({ headline: emailHeadline, issueNumber: issue.issue_number, title: issue.title, detail: emailDetail, url }),
        replyTo: EMAIL_REPLY_TO,
      }),
      createNotificationsForUsers(pushUserIds, {
        type: `facility_${event.type}`,
        title: pushTitle,
        body: pushBody,
        url: issuePath,
        entityType: "facility_issue",
        entityId: issue.id,
      }),
    ]);

    if (pushResult.status === "rejected") console.error("[facility-notify] push failed:", pushResult.reason);
    if (emailResult.status === "rejected") console.error("[facility-notify] email failed:", emailResult.reason);
    if (inAppResult.status === "rejected") console.error("[facility-notify] in-app failed:", inAppResult.reason);
    console.log(`[facility-notify] ${event.type} — push/in-app to ${pushUserIds.length} users, email to ${emailTo.join(", ")}`);
  } catch (err) {
    console.error("[facility-notify] unexpected error:", err);
  }
}

/**
 * Alert all admin users when a category's default assignee is stale
 * (UUID set in DB but user is inactive or not found).
 */
export async function notifyAdminsStaleAssignee(params: {
  categoryId: string;
  issueNumber: string;
  issueTitle: string;
}): Promise<void> {
  try {
    const supabase = createAdminClient();

    const [{ data: cat }, { data: admins }] = await Promise.all([
      supabase.from("facility_asset_categories").select("name").eq("id", params.categoryId).single(),
      supabase.from("users").select("id, email").eq("role", "admin").eq("is_active", true),
    ]);

    const categoryName = cat?.name ?? "Unknown category";
    const adminIds = (admins ?? []).map((a) => a.id as string);
    const adminEmails = (admins ?? []).map((a) => a.email as string).filter(Boolean);

    if (adminIds.length === 0) return;

    const base = process.env.NEXT_PUBLIC_APP_URL || "https://app.theworkvilla.com";
    const settingsUrl = `${base}/facility/settings`;

    await Promise.allSettled([
      sendPushToUsers(adminIds, {
        title: "Facility Routing Warning",
        body: `Issue ${params.issueNumber} opened — category "${categoryName}" has no active assignee. Fix routing at /facility/settings.`,
        url: settingsUrl,
        tag: `facility-stale-assignee-${params.categoryId}`,
      }),
      resend.emails.send({
        from: EMAIL_FROM,
        to: adminEmails,
        subject: `[Action needed] Category "${categoryName}" has no active assignee`,
        html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#dc2626;margin:0 0 8px">Facility Routing Warning</h2>
  <p style="margin:4px 0;color:#555">Issue <strong>${params.issueNumber}</strong> was opened but category <strong>${categoryName}</strong> has no active assignee configured.</p>
  <p style="margin:12px 0;color:#333">The issue was opened unassigned. Please update the routing at Facility Settings.</p>
  <a href="${settingsUrl}" style="display:inline-block;padding:10px 20px;background:#dc2626;color:#fff;text-decoration:none;border-radius:6px;margin-top:8px">Fix Routing</a>
</div>`,
        replyTo: EMAIL_REPLY_TO,
      }),
    ]);
  } catch (err) {
    console.error("[facility-notify] stale-assignee alert failed:", err);
  }
}
