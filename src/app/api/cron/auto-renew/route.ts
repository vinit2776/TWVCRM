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

  return NextResponse.json({
    success: true,
    date: today,
    mode: "dry_run",
    liveRequestedButNotBuilt: requested === "live",
    optedIn: plan.items.length,
    held: plan.held.length,
    dueNow: plan.dueNow.length,
    upcoming: plan.upcoming.length,
    emailed,
  });
}

function todayIst(): string {
  // Date-only form, not a parsed date-time round trip: see cron/vo-renewal for the failure that caused.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export const GET = withCronHealth("cron/auto-renew", handler);
