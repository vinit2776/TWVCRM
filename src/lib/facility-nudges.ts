/**
 * Facility ticket "nudge" — a manual, on-demand ask-for-update sent to a
 * ticket's assignee across push + WhatsApp + email, with per-channel
 * delivery/read tracking surfaced back on the ticket.
 *
 * Unlike notifyIssueAssignee (automatic, policy-gated to creation/escalation
 * only), a nudge is always explicit — someone with permission (override
 * tier or the reporter/delegator) clicked a button, so it always attempts
 * all 3 channels regardless of the broadcast policy.
 */

import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { sendTrackedPushToUsers } from "@/lib/push";
import { sendWhatsApp } from "@/lib/whatsapp";
import { resend, EMAIL_FROM, EMAIL_REPLY_TO } from "@/lib/mailer";

const WA_TEMPLATE_NUDGE = process.env.MSG91_WA_TEMPLATE_FACILITY_NUDGE;

function issueUrl(issueId: string) {
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://app.theworkvilla.com";
  return `${base}/facility/issues/${issueId}`;
}

function trackPixelUrl(nudgeId: string) {
  const base = process.env.NEXT_PUBLIC_APP_URL || "https://app.theworkvilla.com";
  return `${base}/api/facility/nudges/${nudgeId}/track`;
}

export interface NudgeResult {
  id: string;
  channel: "push" | "whatsapp" | "email";
  status: "sent" | "failed";
  error?: string | null;
}

export async function sendIssueNudge(params: {
  issue: { id: string; issue_number: string; title: string; status: string; priority: string };
  targetUserId: string;
  sentBy: { id: string; full_name: string };
}): Promise<NudgeResult[]> {
  const { issue, targetUserId, sentBy } = params;
  const supabase = createAdminClient();

  const { data: target } = await supabase
    .from("users")
    .select("id, full_name, email, phone")
    .eq("id", targetUserId)
    .single();

  if (!target) return [];

  const url = issueUrl(issue.id);
  const results: NudgeResult[] = [];

  // ── Push ────────────────────────────────────────────────────────────
  const batchId = randomUUID();
  const pushResult = await sendTrackedPushToUsers(
    [targetUserId],
    {
      title: `Update needed: ${issue.issue_number}`,
      body: `${sentBy.full_name} is asking for a status update on "${issue.title}"`,
      url,
      tag: `facility-nudge-${issue.id}`,
    },
    batchId
  );
  {
    const { data: row } = await supabase
      .from("facility_issue_nudges")
      .insert({
        issue_id: issue.id,
        channel: "push",
        status: pushResult.sent > 0 ? "sent" : "failed",
        sent_by: sentBy.id,
        provider_ref: batchId,
        error_message: pushResult.sent > 0 ? null : "No active push subscription",
      })
      .select("id, channel, status, error_message")
      .single();
    if (row) results.push({ id: row.id, channel: "push", status: row.status, error: row.error_message });
  }

  // ── WhatsApp ────────────────────────────────────────────────────────
  if (WA_TEMPLATE_NUDGE && target.phone) {
    const waResult = await sendWhatsApp({
      to: target.phone,
      template: WA_TEMPLATE_NUDGE,
      params: [issue.issue_number, issue.status, issue.priority, url],
      entityType: "facility_issue_nudge",
      entityId: issue.id,
    });
    const { data: row } = await supabase
      .from("facility_issue_nudges")
      .insert({
        issue_id: issue.id,
        channel: "whatsapp",
        status: waResult.success ? "sent" : "failed",
        sent_by: sentBy.id,
        provider_ref: waResult.requestId ?? null,
        error_message: waResult.error ?? null,
      })
      .select("id, channel, status, error_message")
      .single();
    if (row) results.push({ id: row.id, channel: "whatsapp", status: row.status, error: row.error_message });
  }

  // ── Email (with open-tracking pixel — sent + opened only, no true
  //    delivery confirmation; matches the pattern used for billing reminders) ──
  if (target.email) {
    const { data: row } = await supabase
      .from("facility_issue_nudges")
      .insert({
        issue_id: issue.id,
        channel: "email",
        status: "sent",
        sent_by: sentBy.id,
      })
      .select("id")
      .single();

    if (row) {
      const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#1a1a1a;margin:0 0 8px">Update needed</h2>
  <p style="margin:4px 0;color:#555"><strong>${issue.issue_number}</strong> — ${issue.title}</p>
  <p style="margin:12px 0;color:#333">${sentBy.full_name} is asking for a status update on this ticket (currently <strong>${issue.status}</strong>, ${issue.priority} priority).</p>
  <a href="${url}" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;margin-top:8px">Update Ticket</a>
  <hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0" />
  <p style="font-size:12px;color:#999">The WorkVilla — Facility Support</p>
  <img src="${trackPixelUrl(row.id)}" width="1" height="1" alt="" style="display:none" />
</div>`;

      try {
        const { error } = await resend.emails.send({
          from: EMAIL_FROM,
          to: target.email,
          subject: `[${issue.issue_number}] Update needed — ${issue.title}`,
          html,
          replyTo: EMAIL_REPLY_TO,
        });
        if (error) {
          await supabase.from("facility_issue_nudges").update({ status: "failed", error_message: error.message }).eq("id", row.id);
          results.push({ id: row.id, channel: "email", status: "failed", error: error.message });
        } else {
          results.push({ id: row.id, channel: "email", status: "sent" });
        }
      } catch (err) {
        await supabase.from("facility_issue_nudges").update({ status: "failed", error_message: String(err) }).eq("id", row.id);
        results.push({ id: row.id, channel: "email", status: "failed", error: String(err) });
      }
    }
  }

  return results;
}
