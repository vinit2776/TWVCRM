import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";
import { withCronHealth } from "@/lib/cron-ping";

export const maxDuration = 60;

/**
 * GET /api/cron/team-activity-digest
 *
 * Nightly recap of what every active team member did today. Sends two kinds
 * of email at once, both scoped to the same "today":
 *   1. A team-wide digest to admin + manager (everyone's activity).
 *   2. A personal recap to each individual active user (their own activity
 *      only — never anyone else's, by construction: each email is built
 *      from that one user's row and nothing else).
 *
 * Distinct from /api/digest (the 8:30 PM IST business digest) — this is
 * built on the activity storyboard's audit_trail data, not the `activities`
 * table.
 *
 * "Today" uses the same IST-labeled-date convention as /api/digest (query
 * bounds are UTC-midnight of the IST calendar date, not true IST midnight —
 * kept consistent with the existing digest rather than introducing a second,
 * subtly different definition of "today").
 *
 * view/login actions are excluded — they're presence signals, not
 * contribution signals, and would dilute a digest meant to show what
 * someone actually did.
 */

// Naive but reliable for this vocabulary: entity_type/action strings are
// regular nouns/verbs (lead, proposal, vendor_bill, ...) where +s / -ed
// works; irregulars are rare enough not to warrant a lookup table.
function pluralizeEntity(entityType: string): string {
  const words = entityType.replace(/_/g, " ");
  return words.endsWith("s") ? words : `${words}s`;
}

const ACTION_VERBS: Record<string, string> = {
  create: "created",
  update: "updated",
  delete: "deleted",
  email_sent: "emailed",
  disable: "disabled",
  enable: "enabled",
  cheque_signed: "signed",
};

function actionVerb(action: string): string {
  return ACTION_VERBS[action] ?? action.replace(/_/g, " ");
}

function describeBreakdown(breakdown: { entity_type: string; action: string; count: number }[]): string {
  return breakdown
    .map((b) => `${b.count} ${pluralizeEntity(b.entity_type)} ${actionVerb(b.action)}`)
    .join(" · ");
}

interface Member {
  id: string;
  full_name: string;
  role: string;
  email: string | null;
  count: number;
  breakdown: { entity_type: string; action: string; count: number }[];
}

function emailWrapper(headerSubtitle: string, dateLabel: string, bodyHtml: string): string {
  return `
<div style="font-family:'Segoe UI',Arial,sans-serif;max-width:660px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;background:#ffffff;">

  <!-- Header -->
  <div style="background:#015E65;padding:24px 32px;">
    <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:700;">The WorkVilla</h1>
    <p style="color:#00AE6C;margin:6px 0 0;font-size:13px;font-weight:500;">${headerSubtitle}</p>
    <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:12px;">${dateLabel}</p>
  </div>

  <div style="padding:28px 32px;">
    ${bodyHtml}
  </div>

  <!-- Footer -->
  <div style="background:#015E65;padding:16px 32px;text-align:center;">
    <p style="color:#ffffff;margin:0;font-size:11px;">SREE DESIGN INFRASTRUCTURE PVT LTD</p>
    <p style="color:rgba(255,255,255,0.7);margin:4px 0 0;font-size:10px;">Prakash Presidium, 110, MG Road, Nungambakkam, Chennai - 600034 | +91 97910 97900</p>
    <p style="color:#00AE6C;margin:4px 0 0;font-size:10px;">www.theworkvilla.com</p>
  </div>

</div>`;
}

function buildTeamDigestHtml(dateLabel: string, active: Member[], inactive: Member[], baseUrl: string): string {
  const totalEvents = active.reduce((sum, m) => sum + m.count, 0);

  const memberCards = active
    .map((m, i) => {
      const accent = i === 0 ? "#00AE6C" : m.count >= 5 ? "#94a3b8" : "#cbd5e1";
      return `
    <div style="border:1px solid #e5e7eb;border-left:3px solid ${accent};border-radius:0 8px 8px 0;padding:14px 16px;margin-bottom:10px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td>
            <span style="font-size:14px;font-weight:700;color:#0f172a;">${m.full_name}</span>
            <span style="font-size:11px;color:#888;margin-left:6px;">${m.role.replace(/_/g, " ")}</span>
          </td>
          <td style="text-align:right;">
            <span style="font-size:18px;font-weight:700;color:#015E65;">${m.count}</span>
            <span style="font-size:11px;color:#888;"> event${m.count === 1 ? "" : "s"}</span>
          </td>
        </tr>
      </table>
      <p style="margin:8px 0 0;font-size:12.5px;color:#4b5563;line-height:1.6;">
        ${describeBreakdown(m.breakdown)}
      </p>
      <a href="${baseUrl}/team/${m.id}/activity" style="display:inline-block;margin-top:8px;font-size:11.5px;color:#015E65;font-weight:600;text-decoration:none;">View full activity →</a>
    </div>`;
    })
    .join("");

  const inactiveHtml = inactive.length > 0
    ? `
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;">
      <p style="margin:0 0 4px;font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.06em;">No activity logged today</p>
      <p style="margin:0;font-size:12.5px;color:#6b7280;">${inactive.map((u) => `${u.full_name} (${u.role.replace(/_/g, " ")})`).join(" · ")}</p>
    </div>`
    : "";

  const body = `
    <!-- Summary strip -->
    <div style="background:#f0faf5;border:1px solid #d1fae5;border-radius:8px;padding:14px 20px;margin-bottom:24px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="text-align:center;padding:4px 8px;">
            <div style="font-size:20px;font-weight:700;color:#015E65;">${active.length}</div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.04em;">active today</div>
          </td>
          <td style="text-align:center;padding:4px 8px;border-left:1px solid #d1fae5;">
            <div style="font-size:20px;font-weight:700;color:#015E65;">${totalEvents}</div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.04em;">events logged</div>
          </td>
          <td style="text-align:center;padding:4px 8px;border-left:1px solid #d1fae5;">
            <div style="font-size:20px;font-weight:700;color:#f59e0b;">${inactive.length}</div>
            <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:0.04em;">no activity</div>
          </td>
        </tr>
      </table>
    </div>

    <p style="font-size:11px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 12px;">Today, by team member</p>

    ${memberCards || `<p style="font-size:13px;color:#888;text-align:center;padding:20px 0;">No activity logged by anyone today.</p>`}

    ${inactiveHtml}
  `;

  return emailWrapper("Team Activity Recap", dateLabel, body);
}

function buildPersonalDigestHtml(dateLabel: string, member: Member, baseUrl: string): string {
  const firstName = member.full_name.split(" ")[0];
  const hasActivity = member.count > 0;

  const body = `
    <p style="font-size:13px;color:#4b5563;margin:0 0 20px;">Hi ${firstName}, here's a quick recap of what you got done today.</p>

    ${hasActivity ? `
    <div style="background:#f0faf5;border:1px solid #d1fae5;border-radius:8px;padding:16px 20px;margin-bottom:16px;text-align:center;">
      <div style="font-size:28px;font-weight:700;color:#015E65;">${member.count}</div>
      <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.04em;">event${member.count === 1 ? "" : "s"} logged today</div>
    </div>
    <p style="font-size:12.5px;color:#4b5563;line-height:1.7;margin:0 0 20px;">${describeBreakdown(member.breakdown)}</p>
    ` : `
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;margin-bottom:20px;text-align:center;">
      <p style="margin:0;font-size:13px;color:#6b7280;">No activity logged today.</p>
    </div>
    `}

    <a href="${baseUrl}/team/${member.id}/activity" style="display:inline-block;font-size:12px;color:#015E65;font-weight:600;text-decoration:none;">View your full activity →</a>
  `;

  return emailWrapper("Your Activity Today", dateLabel, body);
}

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Today in IST (UTC+5:30) — same convention as /api/digest. ?date=YYYY-MM-DD
  // overrides it for on-demand/backfill generation (same param name as /api/digest).
  const { searchParams } = new URL(request.url);
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const todayIST = searchParams.get("date") || istNow.toISOString().slice(0, 10);
  const rangeStart = `${todayIST}T00:00:00`;
  const rangeEnd = `${todayIST}T23:59:59`;
  const dateLabel = new Date(`${todayIST}T00:00:00`).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const { data: users, error: usersError } = await supabase
    .from("users")
    .select("id, full_name, role, email")
    .eq("is_active", true)
    .order("full_name");

  if (usersError) {
    return NextResponse.json({ error: usersError.message }, { status: 500 });
  }
  if (!users || users.length === 0) {
    return NextResponse.json({ sent: false, reason: "no active users" });
  }

  const userIds = users.map((u) => u.id);

  const { data: rows, error: rowsError } = await supabase
    .from("audit_trail")
    .select("performed_by, entity_type, action")
    .in("performed_by", userIds)
    .gte("created_at", rangeStart)
    .lte("created_at", rangeEnd);

  if (rowsError) {
    return NextResponse.json({ error: rowsError.message }, { status: 500 });
  }

  const perUserBreakdown = new Map<string, Map<string, number>>();
  for (const row of rows || []) {
    if (!row.performed_by || row.action === "view" || row.action === "login") continue;
    const breakdown = perUserBreakdown.get(row.performed_by) ?? new Map<string, number>();
    const key = `${row.entity_type}:${row.action}`;
    breakdown.set(key, (breakdown.get(key) || 0) + 1);
    perUserBreakdown.set(row.performed_by, breakdown);
  }

  const allMembers: Member[] = users.map((u) => {
    const breakdownMap = perUserBreakdown.get(u.id);
    const breakdown = breakdownMap
      ? Array.from(breakdownMap.entries())
          .map(([key, count]) => {
            const [entity_type, action] = key.split(":");
            return { entity_type, action, count };
          })
          .sort((a, b) => b.count - a.count)
      : [];
    return {
      id: u.id,
      full_name: u.full_name,
      role: u.role,
      email: u.email,
      count: breakdown.reduce((sum, b) => sum + b.count, 0),
      breakdown,
    };
  });

  const active = allMembers.filter((m) => m.count > 0).sort((a, b) => b.count - a.count);
  const inactive = allMembers.filter((m) => m.count === 0);

  const { data: recipientsData, error: recipientsError } = await supabase
    .from("users")
    .select("email")
    .in("role", ["admin", "manager"])
    .eq("is_active", true);

  if (recipientsError) {
    return NextResponse.json({ error: recipientsError.message }, { status: 500 });
  }

  const teamRecipients = Array.from(
    new Set((recipientsData || []).map((u: { email: string }) => u.email).filter(Boolean))
  );

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.theworkvilla.com";

  const sendResults = await Promise.all([
    teamRecipients.length > 0
      ? resend.emails.send({
          from: EMAIL_FROM,
          replyTo: EMAIL_REPLY_TO,
          to: teamRecipients,
          subject: `Team Activity Recap — ${dateLabel}`,
          html: buildTeamDigestHtml(dateLabel, active, inactive, baseUrl),
        })
      : Promise.resolve(null),
    ...allMembers
      .filter((m) => !!m.email)
      .map((m) =>
        resend.emails.send({
          from: EMAIL_FROM,
          replyTo: EMAIL_REPLY_TO,
          to: m.email as string,
          subject: `Your Activity Today — ${dateLabel}`,
          html: buildPersonalDigestHtml(dateLabel, m, baseUrl),
        })
      ),
  ]);

  const personalSent = sendResults.slice(1).filter((r) => r && !r.error).length;

  return NextResponse.json({
    sent: true,
    team_recipients: teamRecipients.length,
    personal_emails_sent: personalSent,
    personal_emails_attempted: allMembers.filter((m) => !!m.email).length,
    active_members: active.length,
    inactive_members: inactive.length,
    total_events: active.reduce((sum, m) => sum + m.count, 0),
  });
}

export const GET = withCronHealth("cron/team-activity-digest", handler);
