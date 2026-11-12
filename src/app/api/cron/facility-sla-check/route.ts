import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { sendPushToUsers } from "@/lib/push";
import { notifyClaimSlaBreached } from "@/lib/facility-notifications";
import { withCronHealth } from "@/lib/cron-ping";

const OPEN_STATUSES = ["new", "acknowledged", "in_progress", "reopened"];
const NAG_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ISSUE_SELECT = `
      id, issue_number, title, priority, sla_target_at, assigned_to,
      category_id,
      assignee:users!facility_issues_assigned_to_fkey(id, full_name, email)
    `;

/**
 * GET /api/cron/facility-sla-check
 * Runs every 6 hours (see vercel.json). Marks overdue issues as SLA-breached
 * and sends one digest email/push per recipient (not per issue). Tickets that
 * are still open past their SLA get re-included in this alert once per day
 * (via sla_breach_last_notified_at) rather than only at the moment they first
 * breach — otherwise an old breach that nobody acts on goes silent forever.
 */
async function handler(request: NextRequest) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const nagCutoff = new Date(Date.now() - NAG_INTERVAL_MS).toISOString();

  // Issues breaching their SLA for the first time this run.
  const { data: newlyBreached, error: newError } = await supabase
    .from("facility_issues")
    .select(ISSUE_SELECT)
    .in("status", OPEN_STATUSES)
    .eq("sla_breached", false)
    .not("sla_target_at", "is", null)
    .lt("sla_target_at", now);

  if (newError) {
    console.error("[sla-check] query failed:", newError.message);
    return NextResponse.json({ error: newError.message }, { status: 500 });
  }

  // Issues that breached previously, are still open, and haven't been
  // re-nagged in the last 24h.
  const { data: staleBreached, error: staleError } = await supabase
    .from("facility_issues")
    .select(ISSUE_SELECT)
    .in("status", OPEN_STATUSES)
    .eq("sla_breached", true)
    .or(`sla_breach_last_notified_at.is.null,sla_breach_last_notified_at.lt.${nagCutoff}`);

  if (staleError) {
    console.error("[sla-check] stale query failed:", staleError.message);
    return NextResponse.json({ error: staleError.message }, { status: 500 });
  }

  const issues = [...(newlyBreached || []), ...(staleBreached || [])];

  if (issues.length === 0) {
    return NextResponse.json({ checked: 0, breached: 0 });
  }

  // Mark newly-breached issues as breached, and stamp every alerted issue
  // (new or re-nagged) with the notification time so the 24h throttle works.
  const issueIds = issues.map((i) => i.id as string);
  const newlyBreachedIds = (newlyBreached || []).map((i) => i.id as string);
  const [breachUpdate, nagUpdate] = await Promise.all([
    newlyBreachedIds.length > 0
      ? supabase.from("facility_issues").update({ sla_breached: true }).in("id", newlyBreachedIds)
      : Promise.resolve({ error: null }),
    supabase.from("facility_issues").update({ sla_breach_last_notified_at: now }).in("id", issueIds),
  ]);

  const updateError = breachUpdate.error || nagUpdate.error;
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

  console.log(`[sla-check] ${newlyBreachedIds.length} newly breached, ${issueIds.length - newlyBreachedIds.length} re-nagged, notified ${assigneeMap.size} recipients`);

  // ── Claim SLA breach check ────────────────────────────────────────────────
  // Find unowned open tickets that have exceeded their time-to-claim deadline
  const { data: unclaimedBreached } = await supabase
    .from("facility_issues")
    .select("id, issue_number, title, priority")
    .eq("status", "new")
    .is("assigned_to", null)
    .eq("claim_sla_breached", false)
    .not("claim_sla_target_at", "is", null)
    .lt("claim_sla_target_at", now);

  if (unclaimedBreached && unclaimedBreached.length > 0) {
    const unclaimedIds = unclaimedBreached.map((i) => i.id as string);
    await supabase
      .from("facility_issues")
      .update({ claim_sla_breached: true })
      .in("id", unclaimedIds);

    await notifyClaimSlaBreached(
      unclaimedBreached.map((i) => ({
        id: i.id as string,
        issue_number: i.issue_number as string,
        title: i.title as string,
        priority: i.priority as string,
      }))
    );
    console.log(`[sla-check] claim SLA: marked ${unclaimedIds.length} unclaimed breaches`);
  }

  return NextResponse.json({
    checked: issues.length,
    newly_breached: newlyBreachedIds.length,
    re_nagged: issueIds.length - newlyBreachedIds.length,
    claim_breached: unclaimedBreached?.length ?? 0,
  });
}

export const GET = withCronHealth("cron/facility-sla-check", handler);
