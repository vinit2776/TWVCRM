import { createAdminClient } from "@/lib/supabase/server";
import { sendPushToUsers } from "@/lib/push";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { sendWhatsApp } from "@/lib/whatsapp";

type IssueRef = {
  id: string;
  category_id?: string | null;
  assigned_to?: string | null;
  issue_number: string;
  title: string;
};

export type FacilityNotifyEvent =
  | { type: "created"; priority: string; reportedBy: string }
  | {
      type: "status_changed"; from: string; to: string; actorName: string;
      reporterEmail?: string | null; satisfactionToken?: string | null;
    }
  | { type: "priority_escalated"; from: string; to: string; actorName: string }
  | { type: "assigned"; assigneeName: string | null; actorName: string }
  | { type: "claimed"; claimerName: string }
  | { type: "taken_over"; newOwnerName: string }
  | { type: "comment"; actorName: string; message: string };

// Events urgent enough to broadcast across every channel (push + email +
// WhatsApp + in-app). Everything else is push + in-app only — avoids
// paging someone by email/WhatsApp for routine status changes, comments,
// or reassignment. See CLAUDE.md-adjacent decision log: only creation and
// escalation (priority raised, or reopened after resolution) broadcast.
const FULL_BROADCAST_EVENTS = new Set(["created", "priority_escalated", "reopened"]);

// Approved MSG91 WhatsApp template name for ticket assignment/escalation —
// set once the template is approved (see draft in facility settings docs).
// .trim() — a stray newline pasted into the Vercel env var makes MSG91 reject
// the template name outright. See the envStr() note in src/lib/whatsapp.ts.
const WA_TEMPLATE_ASSIGNED = process.env.MSG91_WA_TEMPLATE_FACILITY_ASSIGNED?.trim() || undefined;

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
 * Falls back to managers + office_admin if the issue has no assignee.
 * Returns the user IDs that were actually notified, so callers can avoid
 * double-pinging someone (e.g. an @mention on a user who's already the assignee).
 */
export async function notifyIssueAssignee(issue: IssueRef, event: FacilityNotifyEvent): Promise<string[]> {
  try {
    const supabase = createAdminClient();
    const url = issueUrl(issue.id);

    // Look up backup assignee from category
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

    // For taken_over event: notify the PREVIOUS assignee (stored in assigned_to before the update)
    // The caller must pass the previous assigned_to in issue.assigned_to for this event type.
    if (event.type === "taken_over") {
      if (issue.assigned_to) recipientIds.push(issue.assigned_to);
    } else {
      if (issue.assigned_to) recipientIds.push(issue.assigned_to);
      if (backupAssigneeId && !recipientIds.includes(backupAssigneeId)) {
        recipientIds.push(backupAssigneeId);
      }
      for (const cid of collabUserIds) {
        if (!recipientIds.includes(cid)) recipientIds.push(cid);
      }
    }

    let pushUserIds: string[];
    let emailTo: string[];
    let waPhones: string[];

    if (recipientIds.length === 0) {
      // No assignee — route to managers + office_admin
      const { data: routing } = await supabase
        .from("users")
        .select("id, email, phone")
        .in("role", ["manager", "office_admin"])
        .eq("is_active", true);
      pushUserIds = (routing ?? []).map((u) => u.id as string);
      emailTo = (routing ?? []).map((u) => u.email as string).filter(Boolean);
      waPhones = (routing ?? []).map((u) => u.phone as string).filter(Boolean);
    } else {
      pushUserIds = recipientIds;
      const { data: userRows } = await supabase
        .from("users")
        .select("id, email, phone")
        .in("id", recipientIds);
      emailTo = (userRows ?? []).map((u) => u.email as string).filter(Boolean);
      waPhones = (userRows ?? []).map((u) => u.phone as string).filter(Boolean);
    }

    if (pushUserIds.length === 0) return [];

    // "reopened" arrives as a status_changed event — treat it as its own
    // broadcast tier without needing a separate event type end-to-end.
    const broadcastKey = event.type === "status_changed" && event.to === "reopened" ? "reopened" : event.type;
    const isFullBroadcast = FULL_BROADCAST_EVENTS.has(broadcastKey);
    const skipEmail = !isFullBroadcast;

    let pushTitle: string;
    let pushBody: string;
    let emailSubject: string;
    let emailHeadline: string;
    let emailDetail: string;
    // Built inside the switch below (resolved/closed reporter email) and joined
    // into the Promise.allSettled batch further down — NOT fired standalone.
    // A detached, unawaited promise here would race the serverless function's
    // teardown: the handler can return (and the runtime can freeze/kill the
    // function) before an unawaited SMTP send finishes, silently dropping the
    // email. This bit TWV before — the reporter email had never actually
    // delivered despite existing in code.
    let reporterEmailPromise: Promise<unknown> = Promise.resolve(null);

    switch (event.type) {
      case "created":
        pushTitle = `New Ticket: ${issue.issue_number}`;
        pushBody = `${issue.title} [${event.priority.toUpperCase()}] — reported by ${event.reportedBy}`;
        emailSubject = `[${issue.issue_number}] New Ticket: ${issue.title}`;
        emailHeadline = "New Facility Ticket Submitted";
        emailDetail = `<strong>Priority:</strong> ${event.priority.toUpperCase()}<br/><strong>Reported by:</strong> ${event.reportedBy}`;
        break;
      case "priority_escalated":
        pushTitle = `${issue.issue_number} — Priority Escalated`;
        pushBody = `${event.from} → ${event.to} by ${event.actorName}`;
        emailSubject = `[${issue.issue_number}] Priority escalated: ${event.from} → ${event.to}`;
        emailHeadline = "Ticket Priority Escalated";
        emailDetail = `<strong>Priority:</strong> ${event.from} → ${event.to}<br/><strong>Escalated by:</strong> ${event.actorName}`;
        break;
      case "status_changed":
        pushTitle = broadcastKey === "reopened" ? `${issue.issue_number} — Reopened` : `${issue.issue_number} — Status Update`;
        pushBody = `${event.from} → ${event.to} by ${event.actorName}`;
        emailSubject = `[${issue.issue_number}] Status: ${event.from} → ${event.to}`;
        emailHeadline = broadcastKey === "reopened" ? "Ticket Reopened" : "Ticket Status Updated";
        emailDetail = `<strong>Status:</strong> ${event.from} → ${event.to}<br/><strong>Updated by:</strong> ${event.actorName}`;
        // Also email the reporter when resolved — resolved is the terminal status
        // (closed is retired), so this is the only completion state that fires.
        // Appends a satisfaction-survey CTA — satisfaction_token is stamped on
        // every issue at creation (DB default), so it's always available.
        if (event.to === "resolved" && event.reporterEmail) {
          const surveyUrl = event.satisfactionToken
            ? `${(process.env.NEXT_PUBLIC_APP_URL || "https://app.theworkvilla.com")}/facility/satisfaction/${event.satisfactionToken}`
            : null;
          reporterEmailPromise = resend.emails.send({
            from: EMAIL_FROM,
            to: event.reporterEmail,
            subject: `[${issue.issue_number}] Your ticket has been resolved`,
            html: emailHtml({
              headline: "Ticket Resolved",
              issueNumber: issue.issue_number,
              title: issue.title,
              detail: `Your facility ticket has been marked <strong>resolved</strong> by ${event.actorName}. Thank you for reporting!`
                + (surveyUrl ? `<br/><br/>How did we do? <a href="${surveyUrl}" style="color:#2563eb">Rate your experience</a> — it takes 10 seconds.` : ""),
              url,
            }),
            replyTo: EMAIL_REPLY_TO,
          });
        }
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
      case "claimed":
        pushTitle = `${issue.issue_number} — Claimed`;
        pushBody = `${event.claimerName} claimed this ticket`;
        emailSubject = `[${issue.issue_number}] Ticket claimed by ${event.claimerName}`;
        emailHeadline = "Ticket Claimed";
        emailDetail = `<strong>${event.claimerName}</strong> has claimed and acknowledged this ticket.`;
        break;
      case "taken_over":
        pushTitle = `${issue.issue_number} — Taken over`;
        pushBody = `${event.newOwnerName} took over this ticket from you`;
        emailSubject = `[${issue.issue_number}] Taken over by ${event.newOwnerName}`;
        emailHeadline = "Ticket Taken Over";
        emailDetail = `<strong>${event.newOwnerName}</strong> has taken over ownership of this ticket.`;
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

    const emailPromise = skipEmail
      ? Promise.resolve(null)
      : resend.emails.send({
          from: EMAIL_FROM,
          to: emailTo,
          subject: emailSubject,
          html: emailHtml({ headline: emailHeadline, issueNumber: issue.issue_number, title: issue.title, detail: emailDetail, url }),
          replyTo: EMAIL_REPLY_TO,
        });

    // WhatsApp only for the full-broadcast tier (creation / priority escalation /
    // reopened) — everything else stays push + in-app to avoid paging people.
    const waPromises = isFullBroadcast && WA_TEMPLATE_ASSIGNED
      ? waPhones.map((phone) =>
          sendWhatsApp({
            to: phone,
            template: WA_TEMPLATE_ASSIGNED,
            params: [issue.issue_number, pushBody, url],
            entityType: "facility_issue",
            entityId: issue.id,
          })
        )
      : [];

    const [pushResult, emailResult, inAppResult, reporterEmailResult, ...waResults] = await Promise.allSettled([
      sendPushToUsers(pushUserIds, { title: pushTitle, body: pushBody, url, tag: `facility-${issue.id}` }),
      emailPromise,
      createNotificationsForUsers(pushUserIds, {
        type: `facility_${event.type}`,
        title: pushTitle,
        body: pushBody,
        url: issuePath,
        entityType: "facility_issue",
        entityId: issue.id,
      }),
      reporterEmailPromise,
      ...waPromises,
    ]);

    if (pushResult.status === "rejected") console.error("[facility-notify] push failed:", pushResult.reason);
    if (emailResult.status === "rejected") console.error("[facility-notify] email failed:", emailResult.reason);
    if (inAppResult.status === "rejected") console.error("[facility-notify] in-app failed:", inAppResult.reason);
    if (reporterEmailResult.status === "rejected") console.error("[facility-notify] reporter email failed:", reporterEmailResult.reason);
    waResults.forEach((r) => { if (r.status === "rejected") console.error("[facility-notify] whatsapp failed:", r.reason); });
    console.log(`[facility-notify] ${event.type} — push/in-app to ${pushUserIds.length} users, email to ${emailTo.join(", ")}${isFullBroadcast ? `, whatsapp to ${waPhones.length}` : ""}`);
    return pushUserIds;
  } catch (err) {
    console.error("[facility-notify] unexpected error:", err);
    return [];
  }
}

/**
 * Notify specific users that they were @mentioned in a comment — push + in-app
 * only, same tier as a plain comment (see FULL_BROADCAST_EVENTS above). Anyone
 * who'd already be notified via notifyIssueAssignee for this same comment
 * should be excluded by the caller so they don't get pinged twice.
 */
export async function notifyMentionedUsers(
  issue: IssueRef,
  params: { actorName: string; message: string; userIds: string[] }
): Promise<void> {
  if (params.userIds.length === 0) return;
  try {
    const url = issueUrl(issue.id);
    const pushTitle = `${issue.issue_number} — You were mentioned`;
    const pushBody = `${params.actorName}: ${params.message.slice(0, 100)}`;
    const issuePath = `/facility/issues/${issue.id}`;

    const [pushResult, inAppResult] = await Promise.allSettled([
      sendPushToUsers(params.userIds, { title: pushTitle, body: pushBody, url, tag: `facility-${issue.id}` }),
      createNotificationsForUsers(params.userIds, {
        type: "facility_mentioned",
        title: pushTitle,
        body: pushBody,
        url: issuePath,
        entityType: "facility_issue",
        entityId: issue.id,
      }),
    ]);

    if (pushResult.status === "rejected") console.error("[facility-notify] mention push failed:", pushResult.reason);
    if (inAppResult.status === "rejected") console.error("[facility-notify] mention in-app failed:", inAppResult.reason);
    console.log(`[facility-notify] mentioned — push/in-app to ${params.userIds.length} users`);
  } catch (err) {
    console.error("[facility-notify] mention notify failed:", err);
  }
}

/**
 * Notify managers + office_admin about unowned tickets that breached claim SLA.
 */
export async function notifyClaimSlaBreached(issues: { id: string; issue_number: string; title: string; priority: string }[]): Promise<void> {
  try {
    const supabase = createAdminClient();
    const { data: routing } = await supabase
      .from("users")
      .select("id, email, full_name")
      .in("role", ["manager", "office_admin"])
      .eq("is_active", true);

    const recipients = routing ?? [];
    if (recipients.length === 0) return;

    const base = process.env.NEXT_PUBLIC_APP_URL || "https://app.theworkvilla.com";
    const recipientIds = recipients.map((u) => u.id as string);
    const recipientEmails = recipients.map((u) => u.email as string).filter(Boolean);

    const rows = issues
      .map(
        (i) =>
          `<tr>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5">
              <a href="${base}/facility/issues/${i.id}" style="color:#2563eb;text-decoration:none">${i.issue_number}</a>
            </td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5">${i.title}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;text-transform:uppercase;font-weight:bold;color:#dc2626">${i.priority}</td>
          </tr>`
      )
      .join("");

    const html = `
<div style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:24px">
  <h2 style="color:#d97706;margin:0 0 8px">Unclaimed Ticket Alert</h2>
  <p style="color:#555;margin:0 0 16px">The following tickets have no owner and have exceeded the claim SLA. Please assign them now.</p>
  <table style="width:100%;border-collapse:collapse">
    <thead>
      <tr style="background:#fef3c7">
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5">Ticket</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5">Title</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5">Priority</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <a href="${base}/facility/issues" style="display:inline-block;padding:10px 20px;background:#d97706;color:#fff;text-decoration:none;border-radius:6px;margin-top:16px">View Unowned Tickets</a>
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0"/>
  <p style="font-size:12px;color:#999">The WorkVilla — Facility Support</p>
</div>`;

    await Promise.allSettled([
      sendPushToUsers(recipientIds, {
        title: `${issues.length} ticket${issues.length > 1 ? "s" : ""} unclaimed past SLA`,
        body: issues.map((i) => i.issue_number).join(", "),
        url: `${base}/facility/issues`,
        tag: `facility-claim-sla-digest`,
      }),
      resend.emails.send({
        from: EMAIL_FROM,
        to: recipientEmails,
        subject: `[Action needed] ${issues.length} ticket${issues.length > 1 ? "s" : ""} unclaimed past SLA`,
        html,
        replyTo: EMAIL_REPLY_TO,
      }),
    ]);
  } catch (err) {
    console.error("[facility-notify] claim-sla-breach alert failed:", err);
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
