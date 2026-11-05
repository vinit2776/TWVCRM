import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resend, EMAIL_FROM } from "@/lib/mailer";
import { withCronHealth } from "@/lib/cron-ping";
import { getCachedSettings } from "@/lib/app-settings-cache";
import {
  AUTO_RENEW_CRON_MODE_SETTING,
  parseAutoRenewMode,
  parseAutoRenewTiming,
} from "@/lib/auto-renewal";
import { digestSubject, planAutoRenewals, renderDigestHtml } from "@/lib/auto-renewal-plan";
import { loadAutoRenewFacts } from "@/lib/auto-renewal-plan-server";
import { NOTICE_MODE_SETTING, NOTICE_KIND_LABELS, parseNoticeMode } from "@/lib/auto-renewal-notice";
import { runNoticeJob, type NoticeJobLine, type NoticeJobResult } from "@/lib/auto-renewal-notice-server";
import { escapeHtml } from "@/lib/auto-renewal-plan";

export const maxDuration = 60;

/**
 * Auto-renewal job: daily 06:00 IST, part 2 of 4, DRY RUN ONLY.
 *
 * For every contract that has auto-renewal switched on (contracts.auto_renew,
 * off everywhere until a person turns it on), it works out where the contract
 * is in its renewal schedule and what it would do today, then emails an
 * internal digest to admin and accounts: who needs a person, what is due now,
 * and what is coming up in the next 30 days.
 *
 * It changes nothing and contacts no customer. It does not prepare drafts,
 * send notices or roll terms; those arrive in parts 3 and 4.
 *
 * MODE (app_settings.auto_renew_cron_mode):
 *   off      does nothing
 *   dry_run  (default; anything unrecognised means this) emails the digest
 *   live     not built yet. Treated as dry_run and reported as such, so
 *            setting it early cannot make this job act.
 * Nothing in the URL can change the mode.
 *
 * With no contracts opted in it sends nothing at all.
 */

const DIGEST_RECIPIENTS = ["admin@theworkvilla.com", "accounts@theworkvilla.com"];

async function handler(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("Authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = await createAdminClient();
  const today = todayIst();

  const settings = await getCachedSettings(admin, [
    AUTO_RENEW_CRON_MODE_SETTING,
    NOTICE_MODE_SETTING,
    "auto_renew_draft_lead_days",
    "auto_renew_notice_lead_days",
    "auto_renew_confirmation_days",
  ]);
  const requested = parseAutoRenewMode(settings[AUTO_RENEW_CRON_MODE_SETTING]);
  if (requested === "off") {
    return NextResponse.json({ success: true, date: today, mode: "off", skipped: "auto_renew_cron_mode is off" });
  }

  const facts = await loadAutoRenewFacts(admin, today);
  if (facts === null) {
    return NextResponse.json({ success: true, date: today, skipped: "auto-renewal columns are not on this database yet" });
  }
  if (facts.length === 0) {
    return NextResponse.json({ success: true, date: today, mode: "dry_run", optedIn: 0, emailed: false });
  }

  const plan = planAutoRenewals(facts, today, parseAutoRenewTiming(settings));

  let emailed = false;
  try {
    await resend.emails.send({
      from: EMAIL_FROM,
      to: DIGEST_RECIPIENTS,
      subject: digestSubject(plan, true),
      html: renderDigestHtml(plan, { dryRun: true, appUrl: process.env.NEXT_PUBLIC_APP_URL }),
    });
    emailed = true;
  } catch (err) {
    console.error("[cron/auto-renew] digest email failed:", err instanceof Error ? err.message : "unknown error");
  }

  // Notices have their own switch: drafts and approved sends happen only when it is live.
  // The term roll is still not built, so cron mode alone never makes this job act.
  const noticeMode = parseNoticeMode(settings[NOTICE_MODE_SETTING]);
  let notices: NoticeJobResult | null = null;
  let noticeEmailed = false;
  if (noticeMode === "live") {
    try {
      notices = await runNoticeJob(admin, plan, today);
      const html = notices.available ? renderNoticesHtml(notices, process.env.NEXT_PUBLIC_APP_URL) : null;
      if (html) {
        await resend.emails.send({
          from: EMAIL_FROM,
          to: DIGEST_RECIPIENTS,
          subject: noticesSubject(notices),
          html,
        });
        noticeEmailed = true;
      }
    } catch (err) {
      console.error("[cron/auto-renew] notice stage failed:", err instanceof Error ? err.message : "unknown error");
    }
  }

  return NextResponse.json({
    success: true,
    date: today,
    mode: "dry_run",
    noticeMode,
    notices: notices && {
      available: notices.available,
      prepared: notices.prepared.length,
      sent: notices.sent.length,
      failed: notices.failed.length,
      heldBack: notices.heldBack.length,
      awaitingApproval: notices.awaitingApproval.length,
      late: notices.late.length,
      emailed: noticeEmailed,
    },
    liveRequestedButNotBuilt: requested === "live",
    optedIn: plan.items.length,
    held: plan.held.length,
    dueNow: plan.dueNow.length,
    upcoming: plan.upcoming.length,
    emailed,
  });
}

function noticesSubject(n: NoticeJobResult): string {
  const parts: string[] = [];
  if (n.awaitingApproval.length) parts.push(`${n.awaitingApproval.length} to approve`);
  if (n.late.length) parts.push(`${n.late.length} late`);
  if (n.failed.length) parts.push(`${n.failed.length} failed`);
  if (n.sent.length) parts.push(`${n.sent.length} sent`);
  return `Auto-renewal notices: ${parts.join(", ") || "nothing to do"}`;
}

/** Internal email: what needs a person. Null when there is nothing to say. */
function renderNoticesHtml(n: NoticeJobResult, appUrl?: string): string | null {
  const sections: [string, NoticeJobLine[]][] = [
    ["Late: their day has passed and they have not gone out. Open the contract to send by hand.", n.late],
    ["Failed to send", n.failed],
    ["Approved but held back (the contract now needs a person)", n.heldBack],
    ["Drafts waiting for approval", n.awaitingApproval],
    ["Sent today", n.sent],
  ];
  if (sections.every(([, rows]) => rows.length === 0)) return null;
  const rows = (lines: NoticeJobLine[]) =>
    lines
      .map(
        (l) =>
          `<li>${escapeHtml(l.contractNumber)}, ${escapeHtml(l.customer)}: ${NOTICE_KIND_LABELS[l.kind]}${l.detail ? ` (${escapeHtml(l.detail)})` : ""}</li>`,
      )
      .join("");
  const link = appUrl ? `<p><a href="${escapeHtml(appUrl)}/contracts/auto-renewals">Open the auto-renewals board</a></p>` : "";
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333">
    <h2 style="color:#015E65">Auto-renewal customer notices</h2>
    ${sections
      .filter(([, lines]) => lines.length > 0)
      .map(([title, lines]) => `<h3>${title}</h3><ul>${rows(lines)}</ul>`)
      .join("")}
    ${link}</div>`;
}

function todayIst(): string {
  // Date-only form, not a parsed date-time round trip: see cron/vo-renewal for the failure that caused.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export const GET = withCronHealth("cron/auto-renew", handler);
