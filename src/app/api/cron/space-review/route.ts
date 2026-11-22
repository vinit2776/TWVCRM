import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { sendPushToUsers } from "@/lib/push";
import { withCronHealth } from "@/lib/cron-ping";
import { lastLookAt, lookAgainDue, parseReviewDays, parseSpaceReviewMode, reviewDue } from "@/lib/space-review";

/**
 * GET /api/cron/space-review
 *
 * Daily. Two reminders for enquiries waiting for space, both staff only (it never contacts a customer):
 *  - Look again: the date a person set has come, so a task "Look again: <name>" goes to the lead's
 *    owner (or whoever parked it), once.
 *  - Review: an enquiry that has waited `space_review_days` (60) with no look since is asked about
 *    again; each owner gets one in-app + push message listing how many, once per wait. They answer on
 *    the Waiting for space list: Still waiting, or Close as no response.
 * Mode `space_review_mode`: off / dry_run (default: reports, creates and sends nothing) / live.
 * `?dry=1` forces a preview.
 */
async function handler(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = createAdminClient();
  const { data: settings } = await admin.from("app_settings").select("key, value").in("key", ["space_review_mode", "space_review_days", "space_waiting_enabled"]);
  const setting = (k: string) => (settings ?? []).find((s) => s.key === k)?.value as string | undefined;
  if (setting("space_waiting_enabled") !== "true") return NextResponse.json({ skipped: "waiting for space is off" });
  const mode = parseSpaceReviewMode(setting("space_review_mode"));
  if (mode === "off") return NextResponse.json({ mode, skipped: true });
  const dry = mode !== "live" || request.nextUrl.searchParams.get("dry") === "1";
  const days = parseReviewDays(setting("space_review_days"));

  const { data } = await admin
    .from("parked_enquiries")
    .select("id, lead_id, parked_by, parked_at, look_again_on, last_reviewed_at, review_notified_at, look_again_notified_at, lead:leads!parked_enquiries_lead_id_fkey(first_name, last_name, assigned_to)")
    .neq("state", "released")
    .limit(1000);
  type Row = {
    id: string; lead_id: string; parked_by: string | null; parked_at: string; look_again_on: string | null; last_reviewed_at: string | null;
    review_notified_at: string | null; look_again_notified_at: string | null;
    lead: { first_name: string; last_name: string | null; assigned_to: string | null } | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  const owner = (r: Row) => r.lead?.assigned_to ?? r.parked_by;
  const nameOf = (r: Row) => `${r.lead?.first_name ?? ""} ${r.lead?.last_name === "-" ? "" : (r.lead?.last_name ?? "")}`.trim() || "an enquiry";

  const looks = rows.filter((r) => lookAgainDue(r.look_again_on) && !r.look_again_notified_at && owner(r));
  // Told once per wait: a review reminder newer than the last look means this one has been asked.
  const reviews = rows.filter((r) => reviewDue({ parkedAt: r.parked_at, lastReviewedAt: r.last_reviewed_at }, days) && owner(r) && !(r.review_notified_at && r.review_notified_at >= lastLookAt(r.parked_at, r.last_reviewed_at)));

  if (dry) return NextResponse.json({ mode, dry: true, days, lookAgain: looks.map((r) => nameOf(r)), review: reviews.map((r) => nameOf(r)) });

  const now = new Date().toISOString();
  for (const r of looks) {
    const to = owner(r) as string;
    const { data: claimed } = await admin.from("parked_enquiries").update({ look_again_notified_at: now }).eq("id", r.id).is("look_again_notified_at", null).select("id");
    if (!claimed || claimed.length === 0) continue;
    await admin.from("tasks").insert({
      title: `Look again: ${nameOf(r)}`,
      description: "You asked to look at this waiting enquiry again today. Is there space to offer yet?",
      status: "todo", priority: "medium", lead_id: r.lead_id, assigned_to: to, tags: [] as string[], kind: "other",
      brief: { discussed: "Waiting for space: look-again date reached.", proposal_kind: null }, created_by: to,
    });
    await createNotificationsForUsers([to], { type: "space_look_again", title: `Look again: ${nameOf(r)}`, body: "Your look-again date for this waiting enquiry has come.", url: `/leads/${r.lead_id}/activity`, entityType: "lead", entityId: r.lead_id });
  }

  const byOwner = new Map<string, Row[]>();
  for (const r of reviews) byOwner.set(owner(r) as string, [...(byOwner.get(owner(r) as string) ?? []), r]);
  for (const [to, list] of byOwner) {
    const claimed: string[] = [];
    for (const r of list) {
      const { data: ok } = await admin.from("parked_enquiries").update({ review_notified_at: now }).eq("id", r.id).neq("state", "released").select("id");
      if (ok && ok.length > 0) claimed.push(r.id);
    }
    if (claimed.length === 0) continue;
    const title = `${claimed.length} enquir${claimed.length === 1 ? "y has" : "ies have"} waited a long time for space`;
    const body = "Still waiting, or close as no response? Answer on the Waiting for space list.";
    await createNotificationsForUsers([to], { type: "space_review", title, body, url: "/leads?view=waiting", entityType: "lead_enquiry" });
    void sendPushToUsers([to], { title, body, url: "/leads?view=waiting", tag: `space-review-${to}` }).catch(() => {});
  }
  return NextResponse.json({ mode, dry: false, days, lookAgain: looks.length, review: reviews.length });
}

export const GET = withCronHealth("cron/space-review", handler);
