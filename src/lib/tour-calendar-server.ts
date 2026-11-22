import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteTourEvent, isWorkspaceEmail, upsertTourEvent } from "@/lib/google-calendar";
import { buildTourEventBody, staleCalendarUsers, tourCalendarPeople } from "@/lib/tour-calendar";

/**
 * Puts the tour on the host's and the accompanier's own calendars, and keeps those entries right
 * when the time moves, the host or accompanier changes, or the tour is cancelled or missed. Behind
 * `tour_calendar_enabled`. The customer is never added and nobody is emailed an invite. Never throws:
 * a calendar problem must not stop a tour from being booked or changed.
 */
export async function syncTourCalendar(admin: SupabaseClient, tourId: string): Promise<void> {
  try {
    const { data: flag } = await admin.from("app_settings").select("value").eq("key", "tour_calendar_enabled").maybeSingle();
    if (flag?.value !== "true") return;

    const { data: tour } = await admin
      .from("activities")
      .select(
        "id, lead_id, type, meeting_start_at, meeting_end_at, meeting_location, tour_outcome, tour_host_id, accompanier_id, " +
          "lead:leads!activities_lead_id_fkey(first_name, last_name, company, workspace_type, seat_capacity, location:locations!leads_location_id_fkey(name))",
      )
      .eq("id", tourId)
      .single();
    const t = tour as unknown as {
      id: string; lead_id: string; type: string; meeting_start_at: string | null; meeting_end_at: string | null; meeting_location: string | null;
      tour_outcome: string | null; tour_host_id: string | null; accompanier_id: string | null;
      lead: { first_name: string; last_name: string | null; company: string | null; workspace_type: string | null; seat_capacity: number | null; location: { name: string } | null } | null;
    } | null;
    if (!t || t.type !== "tour" || !t.meeting_start_at) return;

    const ids = [t.tour_host_id, t.accompanier_id].filter((x): x is string => !!x);
    const { data: users } = ids.length ? await admin.from("users").select("id, email, full_name").in("id", ids) : { data: [] };
    const byId = new Map(((users ?? []) as { id: string; email: string | null; full_name: string | null }[]).map((u) => [u.id, u]));

    // A tour that did not happen has nothing to remember; otherwise the host and accompanier are the guests.
    const over = t.tour_outcome === "cancelled" || t.tour_outcome === "no_show";
    const wanted = over
      ? []
      : tourCalendarPeople(
          t.tour_host_id ? (byId.get(t.tour_host_id) ?? null) : null,
          t.accompanier_id ? (byId.get(t.accompanier_id) ?? null) : null,
          isWorkspaceEmail,
        );

    const { data: existing } = await admin.from("tour_calendar_events").select("user_id, event_id").eq("activity_id", tourId);
    const have = new Map(((existing ?? []) as { user_id: string; event_id: string }[]).map((e) => [e.user_id, e.event_id]));

    // Entries for people who no longer have this tour.
    const staleIds = staleCalendarUsers([...have.keys()], wanted);
    if (staleIds.length > 0) {
      const { data: staleUsers } = await admin.from("users").select("id, email").in("id", staleIds);
      for (const u of (staleUsers ?? []) as { id: string; email: string | null }[]) {
        if (u.email) await deleteTourEvent({ ownerEmail: u.email, eventId: have.get(u.id) as string });
      }
      await admin.from("tour_calendar_events").delete().eq("activity_id", tourId).in("user_id", staleIds);
    }
    if (wanted.length === 0) return;

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://twv-crm.vercel.app").trim();
    const lead = t.lead;
    const customer = lead ? lead.company || `${lead.first_name} ${lead.last_name === "-" ? "" : (lead.last_name ?? "")}`.trim() : "the customer";
    const requirement = lead ? [lead.workspace_type?.replace(/_/g, " "), lead.seat_capacity ? `${lead.seat_capacity} seats` : null].filter(Boolean).join(" · ") || null : null;
    const hostName = t.tour_host_id ? (byId.get(t.tour_host_id)?.full_name ?? null) : null;

    for (const person of wanted) {
      const body = buildTourEventBody({
        customer,
        centre: t.meeting_location || lead?.location?.name || null,
        startIso: t.meeting_start_at,
        endIso: t.meeting_end_at,
        role: person.role,
        hostName,
        requirement,
        leadUrl: `${appUrl}/leads/${t.lead_id}`,
      });
      const eventId = await upsertTourEvent({ ownerEmail: person.email as string, eventId: have.get(person.userId) ?? null, body });
      if (eventId && eventId !== have.get(person.userId)) {
        await admin.from("tour_calendar_events").upsert({ activity_id: tourId, user_id: person.userId, event_id: eventId }, { onConflict: "activity_id,user_id" });
      }
    }
  } catch (err) {
    console.error("[tour-calendar] sync failed:", err instanceof Error ? err.message : err);
  }
}
