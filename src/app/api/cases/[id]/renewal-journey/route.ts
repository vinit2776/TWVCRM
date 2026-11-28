import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { getCachedSettings } from "@/lib/app-settings-cache";
import { JOURNEY_CASE_SELECT, loadRenewalJourneys } from "@/lib/vo-renewal-journey-load";
import {
  RENEWAL_DESK_WINDOW_DAYS,
  VO_RENEWAL_GRACE_DAYS_SETTING,
  daysUntil,
  parseGraceDays,
} from "@/lib/vo-renewal-desk";

/**
 * GET /api/cases/[id]/renewal-journey — where this case's renewal stands, the
 * next step and who owns it. Read-only: nothing here sends a notice, creates a
 * bill or changes the case.
 *
 * `journey` is null for a case that is not in a renewal yet (more than
 * RENEWAL_DESK_WINDOW_DAYS before its end date) or has no end date.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid case id" }, { status: 400 });

  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const [{ data: row, error }, settings] = await Promise.all([
    supabase.from("cases").select(JOURNEY_CASE_SELECT).eq("id", id).maybeSingle(),
    getCachedSettings(await createAdminClient(), [VO_RENEWAL_GRACE_DAYS_SETTING]),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: "Case not found" }, { status: 404 });

  const c = row as unknown as Record<string, unknown>;
  const endDate = c.end_date as string | null;
  const inRenewal =
    c.status === "renewed" ||
    c.status === "lapsed" ||
    (!!endDate && ["active", "renewal_due", "grace_period"].includes(c.status as string) &&
      daysUntil(endDate, today) <= RENEWAL_DESK_WINDOW_DAYS);
  if (!inRenewal) return NextResponse.json({ data: { journey: null } });

  const journeys = await loadRenewalJourneys(supabase, [c], {
    today,
    graceDays: parseGraceDays(settings[VO_RENEWAL_GRACE_DAYS_SETTING]),
  });
  return NextResponse.json({ data: { journey: journeys.get(id) ?? null } });
}
