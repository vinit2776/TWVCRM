import type { SupabaseClient } from "@supabase/supabase-js";
import { istDayKey } from "@/lib/lead-days";
import { NON_EVENT_SUBJECTS, leadStaleState, latestInstant, type StaleState } from "@/lib/lead-stale";

const CHUNK = 150;

type Row = Record<string, unknown>;

/**
 * The stale state of each lead, from its history: the latest event (a call, a note, a re-enquiry or
 * the lead being created) and whether a follow-up is still booked ahead. This is the one place that
 * reads that history, so the daily archive job and the calendar's "going stale soon" list agree.
 * Throws when the history can't be read.
 */
export async function loadStaleStates(
  client: SupabaseClient,
  leads: { id: string; status: string; created_at: string; pinned_at?: string | null }[],
  now: Date = new Date(),
): Promise<Map<string, StaleState>> {
  const today = istDayKey(now);
  const out = new Map<string, StaleState>();

  for (let i = 0; i < leads.length; i += CHUNK) {
    const chunk = leads.slice(i, i + CHUNK);
    const ids = chunk.map((l) => l.id);
    const [activitiesRes, enquiriesRes] = await Promise.all([
      client
        .from("activities")
        .select("lead_id, created_at, subject, follow_up_date, is_follow_up_done")
        .in("lead_id", ids)
        .limit(8000),
      client.from("lead_enquiries").select("lead_id, received_at").in("lead_id", ids).limit(4000),
    ]);
    const failure = activitiesRes.error ?? enquiriesRes.error;
    if (failure) throw new Error(failure.message);

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
      out.set(
        l.id,
        leadStaleState({
          status: l.status,
          pinnedAt: l.pinned_at ?? null,
          lastEventAt: latestInstant([l.created_at, ...(events.get(l.id) ?? [])]) ?? l.created_at,
          hasFutureFollowUp: ahead.has(l.id),
          now,
        }),
      );
    }
  }
  return out;
}
