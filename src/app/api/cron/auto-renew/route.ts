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
import { ROLL_MODE_SETTING, parseRollMode } from "@/lib/auto-renewal-next-term";
import { runNextTermJob, type NextTermJobResult, type NextTermLine } from "@/lib/auto-renewal-next-term-server";

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
    ROLL_MODE_SETTING,
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

  // Notices and next terms each have their own switch: they act only when it is live.
  // Activating the next term is not built, so cron mode alone never makes this job act.
  const noticeMode = parseNoticeMode(settings[NOTICE_MODE_SETTING]);
  const rollMode = parseRollMode(settings[ROLL_MODE_SETTING]);
  let notices: NoticeJobResult | null = null;
  let nextTerms: NextTermJobResult | null = null;
  let noticeEmailed = false;
  if (noticeMode === "live") {
    try {
      notices = await runNoticeJob(admin, plan, today);
    } catch (err) {
      console.error("[cron/auto-renew] notice stage failed:", err instanceof Error ? err.message : "unknown error");
    }
  }
  if (rollMode === "live") {
    try {
      nextTerms = await runNextTermJob(admin, plan, today);
    } catch (err) {
      console.error("[cron/auto-renew] next-term stage failed:", err instanceof Error ? err.message : "unknown error");
    }
  }
  try {
    const html = renderNoticesHtml(notices?.available ? notices : null, nextTerms, process.env.NEXT_PUBLIC_APP_URL);
    if (html) {
      await resend.emails.send({
        from: EMAIL_FROM,
        to: DIGEST_RECIPIENTS,
        subject: noticesSubject(notices?.available ? notices : null, nextTerms),
        html,
      });
      noticeEmailed = true;
    }
  } catch (err) {
    console.error("[cron/auto-renew] notices email failed:", err instanceof Error ? err.message : "unknown error");
  }

  return NextResponse.json({
    success: true,
    date: today,
    mode: "dry_run",
    noticeMode,
    rollMode,
    nextTerms: nextTerms && {
      prepared: nextTerms.prepared.length,
      failed: nextTerms.failed.length,
      mismatched: nextTerms.mismatched.length,
    },
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

function noticesSubject(n: NoticeJobResult | null, t: NextTermJobResult | null): string {
  const parts: string[] = [];
  if (n?.awaitingApproval.length) parts.push(`${n.awaitingApproval.length} to approve`);
  if (n?.late.length) parts.push(`${n.late.length} late`);
  if ((n?.failed.length ?? 0) + (t?.failed.length ?? 0)) parts.push(`${(n?.failed.length ?? 0) + (t?.failed.length ?? 0)} failed`);
  if (n?.sent.length) parts.push(`${n.sent.length} sent`);
  if (t?.prepared.length) parts.push(`${t.prepared.length} next term${t.prepared.length === 1 ? "" : "s"} ready`);
  return `Auto-renewal: ${parts.join(", ") || "nothing to do"}`;
}

/** Internal email: what needs a person. Null when there is nothing to say. */
function renderNoticesHtml(n: NoticeJobResult | null, t: NextTermJobResult | null, appUrl?: string): string | null {
  const noticeRows = (lines: NoticeJobLine[]) =>
    lines
      .map(
        (l) =>
          `<li>${escapeHtml(l.contractNumber)}, ${escapeHtml(l.customer)}: ${NOTICE_KIND_LABELS[l.kind]}${l.detail ? ` (${escapeHtml(l.detail)})` : ""}</li>`,
      )
      .join("");
  const termRows = (lines: NextTermLine[]) =>
    lines
      .map((l) => `<li>${escapeHtml(l.contractNumber)}, ${escapeHtml(l.customer)}${l.detail ? ` (${escapeHtml(l.detail)})` : ""}</li>`)
      .join("");

  const sections: { title: string; html: string; count: number }[] = [
    { title: "Late: their day has passed and they have not gone out. Open the contract to send by hand.", html: noticeRows(n?.late ?? []), count: n?.late.length ?? 0 },
    { title: "Notices that failed to send", html: noticeRows(n?.failed ?? []), count: n?.failed.length ?? 0 },
    { title: "Next term could not be created. Renew these by hand.", html: termRows(t?.failed ?? []), count: t?.failed.length ?? 0 },
    { title: "Next term's rent is not what the customer was sent. Check before activating.", html: termRows(t?.mismatched ?? []), count: t?.mismatched.length ?? 0 },
    { title: "Notices approved but held back (the contract now needs a person)", html: noticeRows(n?.heldBack ?? []), count: n?.heldBack.length ?? 0 },
    { title: "Notice drafts waiting for approval", html: noticeRows(n?.awaitingApproval ?? []), count: n?.awaitingApproval.length ?? 0 },
    { title: "Next terms ready to activate when they start", html: termRows(t?.prepared ?? []), count: t?.prepared.length ?? 0 },
    { title: "Notices sent today", html: noticeRows(n?.sent ?? []), count: n?.sent.length ?? 0 },
  ].filter((x) => x.count > 0);
  if (sections.length === 0) return null;
  const link = appUrl ? `<p><a href="${escapeHtml(appUrl)}/contracts/auto-renewals">Open the auto-renewals board</a></p>` : "";
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333">
    <h2 style="color:#015E65">Auto-renewal</h2>
    ${sections.map((x) => `<h3>${x.title}</h3><ul>${x.html}</ul>`).join("")}
    ${link}</div>`;
}

function todayIst(): string {
  // Date-only form, not a parsed date-time round trip: see cron/vo-renewal for the failure that caused.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export const GET = withCronHealth("cron/auto-renew", handler);
