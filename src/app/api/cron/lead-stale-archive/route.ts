import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { withCronHealth } from "@/lib/cron-ping";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { parseCronMode } from "@/lib/vo-renewal-reminders";
import { istDayKey } from "@/lib/lead-days";
import {
  STALE_AFTER_DAYS,
  STALE_EXEMPT_STATUSES,
  NON_EVENT_SUBJECTS,
  leadStaleState,
  latestInstant,
} from "@/lib/lead-stale";

/**
 * Lead stale-archive cron: daily 04:00 IST. A lead that has been quiet for 15 days, with nothing
 * booked ahead, is archived (nothing is deleted; Restore brings it back). The rule lives in
 * src/lib/lead-stale.ts and is the same one the Leads list badge uses.
 *
 * It never messages anyone: it only archives leads and leaves a note in each one's history.
 * It skips pinned, won, lost and junk leads, and leads already archived.
 *
 * MODE (app_settings.lead_stale_archive_mode):
 *   off      does nothing
 *   dry_run  (default; missing or unrecognised means this) reports what it WOULD archive
 *   live     archives
 * ?dry_run=1 can turn a live run into a dry run; nothing in the URL can turn a dry run live.
 *
 * At most MAX_PER_RUN leads are archived per run (longest quiet first), so switching to live on a
 * backlog works through it over several days instead of archiving thousands at once.
 */
export const LEAD_STALE_ARCHIVE_MODE_SETTING = "lead_stale_archive_mode";
const MAX_PER_RUN = 100;
const CANDIDATE_LIMIT = 1500;
const CHUNK = 150;
const DAY_MS = 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const settings = await getCachedSettings(admin, [LEAD_STALE_ARCHIVE_MODE_SETTING]);
  let mode = parseCronMode(settings[LEAD_STALE_ARCHIVE_MODE_SETTING]);
  if (request.nextUrl.searchParams.get("dry_run") === "1" && mode === "live") mode = "dry_run";
  if (mode === "off") return NextResponse.json({ mode, message: "Switched off" });

  const now = new Date();
  const cutoff = new Date(now.getTime() - STALE_AFTER_DAYS * DAY_MS).toISOString();
  const today = istDayKey(now);

  // Leads old enough to be stale at all; the real test follows.
  const { data: candidates, error } = await admin
    .from("leads")
    .select("id, lead_number, status, created_at")
    .is("archived_at", null)
    .is("pinned_at", null)
    .not("status", "in", `(${STALE_EXEMPT_STATUSES.join(",")})`)
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(CANDIDATE_LIMIT);
  if (error) {
    console.error("[lead-stale-archive] candidates failed", error.code, error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const leads = (candidates ?? []) as { id: string; lead_number: number | string; status: string; created_at: string }[];
  const stale: { id: string; lead_number: number | string; daysQuiet: number }[] = [];

  for (let i = 0; i < leads.length; i += CHUNK) {
    const chunk = leads.slice(i, i + CHUNK);
    const ids = chunk.map((l) => l.id);
    const [activitiesRes, enquiriesRes] = await Promise.all([
      admin
        .from("activities")
        .select("lead_id, created_at, subject, follow_up_date, is_follow_up_done")
        .in("lead_id", ids)
        .limit(8000),
      admin.from("lead_enquiries").select("lead_id, received_at").in("lead_id", ids).limit(4000),
    ]);
    if (activitiesRes.error || enquiriesRes.error) {
      const e = activitiesRes.error ?? enquiriesRes.error;
      console.error("[lead-stale-archive] history failed", e?.code, e?.message);
      return NextResponse.json({ error: e?.message ?? "history failed" }, { status: 500 });
    }
    const events = new Map<string, (string | null)[]>();
    const ahead = new Set<string>();
    for (const a of (activitiesRes.data ?? []) as Row[]) {
      const id = a.lead_id as string;
      if (!(NON_EVENT_SUBJECTS as readonly string[]).includes((a.subject as string) ?? "")) {
        (events.get(id) ?? events.set(id, []).get(id)!).push(a.created_at as string);
      }
      if (!a.is_follow_up_done && a.follow_up_date && istDayKey(a.follow_up_date as string) >= today) ahead.add(id);
    }
    for (const e of (enquiriesRes.data ?? []) as Row[]) {
      (events.get(e.lead_id as string) ?? events.set(e.lead_id as string, []).get(e.lead_id as string)!).push(e.received_at as string);
    }

    for (const l of chunk) {
      const state = leadStaleState({
        status: l.status,
        lastEventAt: latestInstant([l.created_at, ...(events.get(l.id) ?? [])]) ?? l.created_at,
        hasFutureFollowUp: ahead.has(l.id),
        now,
      });
      if (state.state === "stale") stale.push({ id: l.id, lead_number: l.lead_number, daysQuiet: state.daysQuiet });
    }
  }

  // Longest quiet first, capped.
  stale.sort((a, b) => b.daysQuiet - a.daysQuiet);
  const batch = stale.slice(0, MAX_PER_RUN);

  let archived = 0;
  if (mode === "live" && batch.length > 0) {
    const archivedAt = now.toISOString();
    // The WHERE repeats the guards, so a lead pinned or archived since we looked is left alone.
    const { data: done, error: updateError } = await admin
      .from("leads")
      .update({
        archived_at: archivedAt,
        archived_by: null,
        archive_reason: `Stale: no activity for ${STALE_AFTER_DAYS} days`,
      })
      .in("id", batch.map((l) => l.id))
      .is("archived_at", null)
      .is("pinned_at", null)
      .select("id");
    if (updateError) {
      console.error("[lead-stale-archive] archive failed", updateError.code, updateError.message);
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    const archivedIds = (done ?? []).map((r) => r.id as string);
    archived = archivedIds.length;
    if (archivedIds.length > 0) {
      const { error: noteError } = await admin.from("activities").insert(
        archivedIds.map((id) => ({
          lead_id: id,
          type: "note",
          subject: "Archived automatically",
          description: `No activity for ${STALE_AFTER_DAYS} days and nothing booked ahead. Restore it from the lead if it is still wanted.`,
        })),
      );
      if (noteError) console.error("[lead-stale-archive] history notes failed", noteError.code, noteError.message);
    }
  }

  return NextResponse.json({
    mode,
    candidates: leads.length,
    stale: stale.length,
    wouldArchive: batch.length,
    archived,
    // Lead numbers only: no names or contact details in a cron response.
    sample: batch.slice(0, 20).map((l) => ({ lead: l.lead_number, daysQuiet: l.daysQuiet })),
  });
}

export const GET = withCronHealth("cron/lead-stale-archive", handler);
