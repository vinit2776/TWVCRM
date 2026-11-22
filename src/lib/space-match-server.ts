import type { SupabaseClient } from "@supabase/supabase-js";
import { createNotificationsForUsers } from "@/lib/in-app-notifications";
import { sendPushToUsers } from "@/lib/push";
import { istDayKey } from "@/lib/lead-days";
import { matchParked, parseMatchMode, type SpaceAllocation, type SpaceUnit } from "@/lib/space-match";

export interface MatchRunResult {
  mode: string;
  considered: number;
  /** Enquiries that now have space (newly flagged in live mode, would be in a preview). */
  newlyMatched: { parkedId: string; leadId: string; note: string }[];
  /** Enquiries that had space but no longer do (put back to waiting in live mode). */
  lost: string[];
}

/**
 * Looks at every enquiry waiting for space at a centre and flags the ones that now fit (same centre,
 * a type that fits, enough seats free from their start date for a month). A flagged one that no longer
 * fits goes quietly back to waiting. In live mode the person who parked it and the lead's owner are
 * told in the app and by push, once per match; in preview nothing is written or sent. Staff only: it
 * never contacts a customer. Never throws.
 */
export async function runSpaceMatch(admin: SupabaseClient, opts: { forceDry?: boolean } = {}): Promise<MatchRunResult> {
  const empty = (mode: string): MatchRunResult => ({ mode, considered: 0, newlyMatched: [], lost: [] });
  try {
    const { data: setting } = await admin.from("app_settings").select("value").eq("key", "space_match_mode").maybeSingle();
    const mode = parseMatchMode(setting?.value);
    if (mode === "off") return empty(mode);
    const dry = mode !== "live" || !!opts.forceDry;

    const { data: parked } = await admin
      .from("parked_enquiries")
      .select(
        "id, lead_id, location_id, workspace_type, seats_needed, state, parked_by, " +
          "location:locations!parked_enquiries_location_id_fkey(name), lead:leads!parked_enquiries_lead_id_fkey(first_name, last_name, assigned_to, start_date)",
      )
      .neq("state", "released")
      .not("location_id", "is", null)
      .limit(500);
    type P = {
      id: string; lead_id: string; location_id: string; workspace_type: string | null; seats_needed: number | null; state: string; parked_by: string | null;
      location: { name: string } | null; lead: { first_name: string; last_name: string | null; assigned_to: string | null; start_date: string | null } | null;
    };
    const rows = (parked ?? []) as unknown as P[];
    if (rows.length === 0) return empty(mode);

    const locationIds = [...new Set(rows.map((p) => p.location_id))];
    const [{ data: unitRows }, { data: allocRows }] = await Promise.all([
      admin.from("space_units").select("id, location_id, type, capacity, is_active").in("location_id", locationIds),
      admin.from("contract_space_allocations").select("space_unit_id, start_date, end_date, status, unit:space_units!inner(location_id)").eq("status", "active").in("unit.location_id", locationIds),
    ]);
    const units: SpaceUnit[] = ((unitRows ?? []) as { id: string; location_id: string; type: SpaceUnit["type"]; capacity: number; is_active: boolean }[]).map((u) => ({
      id: u.id, locationId: u.location_id, type: u.type, capacity: u.capacity, isActive: u.is_active,
    }));
    const allocations: SpaceAllocation[] = ((allocRows ?? []) as { space_unit_id: string; start_date: string; end_date: string | null; status: "active" | "ended" }[]).map((a) => ({
      unitId: a.space_unit_id, startDate: a.start_date, endDate: a.end_date, status: a.status,
    }));

    const today = istDayKey(new Date());
    const result: MatchRunResult = { mode, considered: rows.length, newlyMatched: [], lost: [] };
    for (const p of rows) {
      const wantedFrom = p.lead?.start_date && p.lead.start_date > today ? p.lead.start_date : today;
      const m = matchParked({ locationId: p.location_id, workspaceType: p.workspace_type, seatsNeeded: p.seats_needed }, units, allocations, wantedFrom, p.location?.name);
      if (m.matched && p.state === "waiting") result.newlyMatched.push({ parkedId: p.id, leadId: p.lead_id, note: m.note });
      else if (!m.matched && p.state === "space_available") result.lost.push(p.id);
    }
    if (dry) return result;

    const now = new Date().toISOString();
    for (const n of result.newlyMatched) {
      // Compare-and-set so a second run cannot flag, or notify, the same match twice.
      const { data: flagged } = await admin.from("parked_enquiries").update({ state: "space_available", matched_at: now, matched_note: n.note }).eq("id", n.parkedId).eq("state", "waiting").select("id");
      if (!flagged || flagged.length === 0) continue;
      const p = rows.find((r) => r.id === n.parkedId) as P;
      const name = `${p.lead?.first_name ?? ""} ${p.lead?.last_name === "-" ? "" : (p.lead?.last_name ?? "")}`.trim() || "A waiting enquiry";
      const who = [...new Set([p.parked_by, p.lead?.assigned_to].filter((x): x is string => !!x))];
      const title = `Space available for ${name}`;
      await createNotificationsForUsers(who, { type: "space_match", title, body: `${n.note}. Take them out of Waiting for space to make an offer.`, url: `/leads/${p.lead_id}/activity`, entityType: "lead", entityId: p.lead_id });
      void sendPushToUsers(who, { title, body: n.note, url: `/leads/${p.lead_id}/activity`, tag: `space-match-${n.parkedId}` }).catch(() => {});
    }
    if (result.lost.length > 0) {
      await admin.from("parked_enquiries").update({ state: "waiting", matched_at: null, matched_note: null }).in("id", result.lost).eq("state", "space_available");
    }
    return result;
  } catch (err) {
    console.error("[space-match] run failed:", err instanceof Error ? err.message : err);
    return empty("error");
  }
}
