import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadStaleStates } from "../lead-stale-load";

const NOW = new Date("2026-11-20T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400000).toISOString();

/** A client whose tables return fixed rows, whatever the filters. */
function fakeClient(tables: Record<string, unknown[]>, error?: string): SupabaseClient {
  const query = (rows: unknown[]) => {
    const q = { select: () => q, in: () => q, limit: () => Promise.resolve({ data: error ? null : rows, error: error ? { message: error } : null }) };
    return q;
  };
  return { from: (t: string) => query(tables[t] ?? []) } as unknown as SupabaseClient;
}

const lead = (id: string, createdDaysAgo: number, status = "contacted") => ({ id, status, created_at: daysAgo(createdDaysAgo) });

describe("loadStaleStates", () => {
  it("counts quiet days from the latest event, ignoring Claimed/Reassigned notes", async () => {
    const client = fakeClient({
      activities: [
        { lead_id: "a", created_at: daysAgo(13), subject: "Call", follow_up_date: null, is_follow_up_done: true },
        { lead_id: "a", created_at: daysAgo(1), subject: "Reassigned", follow_up_date: null, is_follow_up_done: true },
      ],
    });
    const states = await loadStaleStates(client, [lead("a", 40)], NOW);
    expect(states.get("a")).toEqual({ state: "warning", daysLeft: 2 });
  });

  it("is kept active by a follow-up still ahead, and by a re-enquiry", async () => {
    const client = fakeClient({
      activities: [{ lead_id: "b", created_at: daysAgo(30), subject: "Call", follow_up_date: "2026-11-25T05:00:00Z", is_follow_up_done: false }],
      lead_enquiries: [{ lead_id: "c", received_at: daysAgo(2) }],
    });
    const states = await loadStaleStates(client, [lead("b", 40), lead("c", 40)], NOW);
    expect(states.get("b")).toEqual({ state: "active" });
    expect(states.get("c")).toEqual({ state: "active" });
  });

  it("throws when the history cannot be read", async () => {
    await expect(loadStaleStates(fakeClient({}, "boom"), [lead("a", 40)], NOW)).rejects.toThrow("boom");
  });
});
