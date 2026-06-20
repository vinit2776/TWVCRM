import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { sendPushToUsers } from "@/lib/push";

/**
 * GET /api/cron/facility-sla-check
 * Runs every 6 hours (see vercel.json). Marks overdue issues as SLA-breached
 * and sends one digest email/push per recipient (not per issue).
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // Find all open issues that have breached their SLA but haven't been marked yet
  const { data: issues, error } = await supabase
    .from("facility_issues")
    .select(`
      id, issue_number, title, priority, sla_target_at, assigned_to,
      category_id,
      assignee:users!facility_issues_assigned_to_fkey(id, full_name, email)
    `)
    .in("status", ["new", "acknowledged", "in_progress", "reopened"])
    .eq("sla_breached", false)
    .not("sla_target_at", "is", null)
    .lt("sla_target_at", now);

  if (error) {
    console.error("[sla-check] query failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!issues || issues.length === 0) {
    return NextResponse.json({ checked: 0, breached: 0 });
  }

  // Mark all as breached in one update
  const issueIds = issues.map((i) => i.id as string);
  const { error: updateError } = await supabase
    .from("facility_issues")
    .update({ sla_breached: true })
    .in("id", issueIds);

  if (updateError) {
    console.error("[sla-check] update failed:", updateError.message);
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Build per-assignee digest so each person gets one email, not N emails
  const assigneeMap: Map<string, {
    userId: string;
    name: string;
    email: string;
    issues: typeof issues;
  }> = new Map();

  const unassignedIssues: typeof issues = [];

  for (const issue of issues) {
    const assignee = issue.assignee as unknown as { id: string; full_name: string; email: string } | null;
    if (assignee?.id && assignee.email) {
      const existing = assigneeMap.get(assignee.id);
      if (existing) {
        existing.issues.push(issue);
      } else {
        assigneeMap.set(assignee.id, {
          userId: assignee.id,
          name: assignee.full_name,
          email: assignee.email,
          issues: [issue],
        });
      }
    } else {
      unassignedIssues.push(issue);
    }
  }

  // Also alert admins if there are unassigned SLA breaches
  if (unassignedIssues.length > 0) {
    const { data: admins } = await supabase
      .from("users")
      .select("id, full_name, email")
      .eq("role", "admin")
      .eq("is_active", true);
    for (const admin of admins ?? []) {
      const existing = assigneeMap.get(admin.id as string);
      if (existing) {
        existing.issues.push(...unassignedIssues);
      } else {
        assigneeMap.set(admin.id as string, {
          userId: admin.id as string,
          name: admin.full_name as string,
          email: admin.email as string,
          issues: unassignedIssues,
        });
      }
    }
  }

  const base = process.env.NEXT_PUBLIC_APP_URL || "https://app.theworkvilla.com";

  // Send digests in parallel
  await Promise.allSettled(
    Array.from(assigneeMap.values()).map(async (recipient) => {
      const rows = recipient.issues
        .map(
          (i) =>
            `<tr>
              <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5">
                <a href="${base}/facility/issues/${i.id}" style="color:#2563eb;text-decoration:none">${i.issue_number}</a>
              </td>
              <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5">${i.title}</td>
              <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;text-transform:uppercase;font-weight:bold;color:#dc2626">${i.priority}</td>
              <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;color:#888;font-size:12px">${new Date(i.sla_target_at as string).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
            </tr>`
        )
        .join("");

      const html = `
<div style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:24px">
  <h2 style="color:#dc2626;margin:0 0 8px">SLA Breach Alert</h2>
  <p style="color:#555;margin:0 0 16px">Hi ${recipient.name}, the following tickets have breached their SLA:</p>
  <table style="width:100%;border-collapse:collapse">
    <thead>
      <tr style="background:#f5f5f5">
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5">Ticket</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5">Title</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5">Priority</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e5e5">SLA Due</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <a href="${base}/facility/issues" style="display:inline-block;padding:10px 20px;background:#dc2626;color:#fff;text-decoration:none;border-radius:6px;margin-top:16px">View All Open Tickets</a>
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0"/>
  <p style="font-size:12px;color:#999">The WorkVilla — Facility Support</p>
</div>`;

      await Promise.allSettled([
        resend.emails.send({
          from: EMAIL_FROM,
          to: recipient.email,
          subject: `[SLA Alert] ${recipient.issues.length} ticket${recipient.issues.length > 1 ? "s" : ""} overdue`,
          html,
          replyTo: EMAIL_REPLY_TO,
        }),
        sendPushToUsers([recipient.userId], {
          title: `${recipient.issues.length} SLA breach${recipient.issues.length > 1 ? "es" : ""}`,
          body: recipient.issues.map((i) => i.issue_number).join(", "),
          url: `${base}/facility/issues`,
          tag: `facility-sla-digest`,
        }),
      ]);
    })
  );

  console.log(`[sla-check] marked ${issueIds.length} issues, notified ${assigneeMap.size} recipients`);
  return NextResponse.json({ checked: issues.length, breached: issueIds.length });
}
