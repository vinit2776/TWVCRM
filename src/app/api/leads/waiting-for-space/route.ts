import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { LEAD_HANDLER_ROLES } from "@/lib/constants";
import { daysWaiting, waitingGroupLabel } from "@/lib/space-parking";
import { demandByArea, parseReviewDays, reviewDue } from "@/lib/space-review";

// GET /api/leads/waiting-for-space
// Real enquiries we could not offer yet, oldest wait first, each with what they wanted, why, who
// parked it and for how long. Read-only. Empty when the switch is off.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: me } = await supabase.from("users").select("id, role").eq("auth_id", user.id).single();
  if (!me || !(LEAD_HANDLER_ROLES as readonly string[]).includes(me.role)) return NextResponse.json({ enabled: false, total: 0, rows: [] });

  const { data: settings } = await createAdminClient().from("app_settings").select("key, value").in("key", ["space_waiting_enabled", "space_review_days"]);
  const setting = (k: string) => (settings ?? []).find((s) => s.key === k)?.value as string | undefined;
  if (setting("space_waiting_enabled") !== "true") return NextResponse.json({ enabled: false, total: 0, rows: [] });
  const reviewDays = parseReviewDays(setting("space_review_days"));

  const { data, error } = await supabase
    .from("parked_enquiries")
    .select(
      "id, lead_id, other_area, workspace_type, seats_needed, reason, note, look_again_on, state, parked_at, matched_note, last_reviewed_at, " +
        "location:locations!parked_enquiries_location_id_fkey(name), parker:users!parked_enquiries_parked_by_fkey(full_name), " +
        "lead:leads!parked_enquiries_lead_id_fkey(first_name, last_name, company, assigned_to)",
    )
    .neq("state", "released")
    .order("parked_at", { ascending: true })
    .limit(500);
  if (error) {
    console.error("[waiting-for-space] load failed", error.code, error.message);
    return NextResponse.json({ error: "Could not load the list" }, { status: 500 });
  }
  type Row = {
    id: string; lead_id: string; other_area: string | null; workspace_type: string | null; seats_needed: number | null; reason: string;
    note: string | null; look_again_on: string | null; state: string; parked_at: string; matched_note: string | null; last_reviewed_at: string | null;
    location: { name: string } | null; parker: { full_name: string } | null;
    lead: { first_name: string; last_name: string | null; company: string | null; assigned_to: string | null } | null;
  };
  const rows = ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    leadId: r.lead_id,
    name: r.lead?.company || `${r.lead?.first_name ?? ""} ${r.lead?.last_name === "-" ? "" : (r.lead?.last_name ?? "")}`.trim() || "Unknown",
    group: waitingGroupLabel({ locationName: r.location?.name ?? null, otherArea: r.other_area, reason: r.reason }),
    want: [r.workspace_type?.replace(/_/g, " "), r.seats_needed ? `${r.seats_needed} seats` : null].filter(Boolean).join(" · ") || null,
    reason: r.reason,
    note: r.note,
    lookAgainOn: r.look_again_on,
    state: r.state,
    parkedBy: r.parker?.full_name ?? null,
    daysWaiting: daysWaiting(r.parked_at),
    parkedAt: r.parked_at,
    matchedNote: r.matched_note,
    reviewDue: reviewDue({ parkedAt: r.parked_at, lastReviewedAt: r.last_reviewed_at }, reviewDays),
  }));
  const demand = demandByArea(
    ((data ?? []) as unknown as Row[]).map((r) => ({ locationName: r.location?.name ?? null, otherArea: r.other_area, reason: r.reason, seatsNeeded: r.seats_needed, parkedAt: r.parked_at })),
  );
  return NextResponse.json({ enabled: true, total: rows.length, reviewDays, demand, rows });
}
