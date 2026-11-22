import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { withCronHealth } from "@/lib/cron-ping";
import { logAudit } from "@/lib/audit";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { parseCronMode } from "@/lib/vo-renewal-reminders";
import { voProposalColumnsPresent } from "@/lib/vo-proposal-server";
import { VO_PROPOSAL_EXPIRY_CRON_MODE_SETTING, isVoProposalExpired } from "@/lib/vo-proposal";

/**
 * VO proposal expiry — daily. Marks sent/viewed Virtual Office proposals whose
 * 7-day validity has passed as `expired`. Standard proposals are never touched
 * (their valid_until stays advisory).
 *
 * MODE (app_settings.vo_proposal_expiry_cron_mode), same rules as vo-renewal:
 *   off      does nothing
 *   dry_run  (default; anything unrecognised means this) reports what it WOULD expire
 *   live     expires them
 * ?dry_run=1 can only make a live run more cautious. Customer answers already
 * refuse an expired offer without waiting for this job, so it only keeps the
 * status honest for staff.
 */
async function handler(request: Request) {
  if (request.headers.get("Authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!(await voProposalColumnsPresent())) {
    return NextResponse.json({ success: true, skipped: "VO proposal columns not migrated yet" });
  }

  const admin = createAdminClient();
  const settings = await getCachedSettings(admin, [VO_PROPOSAL_EXPIRY_CRON_MODE_SETTING]);
  let mode = parseCronMode(settings[VO_PROPOSAL_EXPIRY_CRON_MODE_SETTING]);
  if (new URL(request.url).searchParams.get("dry_run") === "1" && mode === "live") mode = "dry_run";
  if (mode === "off") return NextResponse.json({ success: true, mode, skipped: "vo_proposal_expiry_cron_mode is off" });

  const { data: rows, error } = await admin
    .from("proposals")
    .select("id, proposal_number, status, kind, sent_at, expires_at")
    .eq("kind", "virtual_office")
    .in("status", ["sent", "viewed"]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const now = new Date();
  const due = (rows || []).filter((r) => isVoProposalExpired(r, now));
  const expired: string[] = [];
  const errors: string[] = [];

  if (mode === "live") {
    for (const r of due) {
      // Status guard: a customer answer or staff withdraw in the meantime wins.
      const { data: updated, error: upErr } = await admin
        .from("proposals")
        .update({ status: "expired" })
        .eq("id", r.id)
        .in("status", ["sent", "viewed"])
        .select("id")
        .maybeSingle();
      if (upErr) { errors.push(`${r.proposal_number}: ${upErr.message}`); continue; }
      if (!updated) continue;
      expired.push(r.proposal_number);
      logAudit(admin, {
        entityType: "proposal",
        entityId: r.id,
        action: "update",
        performedBy: "system",
        changes: { action: { old: null, new: "vo_proposal_expired" }, status: { old: r.status, new: "expired" } },
      });
    }
  }

  return NextResponse.json({
    success: errors.length === 0,
    mode,
    would_expire: mode === "live" ? undefined : due.map((r) => r.proposal_number),
    expired,
    errors,
  });
}

export const GET = withCronHealth("cron/vo-proposal-expiry", handler);
