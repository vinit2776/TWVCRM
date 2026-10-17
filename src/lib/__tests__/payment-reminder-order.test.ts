import { describe, it, expect } from "vitest";
import { byLeastRecentlyReminded } from "@/lib/payment-reminder";

describe("byLeastRecentlyReminded", () => {
  it("puts never-reminded first, then the longest-waiting", () => {
    const rows = [
      { id: "recent", last_reminder_sent_at: "2026-10-16T04:00:00Z" },
      { id: "never", last_reminder_sent_at: null },
      { id: "old", last_reminder_sent_at: "2026-10-01T04:00:00Z" },
      { id: "never-2" },
    ];
    expect([...rows].sort(byLeastRecentlyReminded).map((r) => r.id)).toEqual(
      ["never", "never-2", "old", "recent"]
    );
  });

  it("keeps ties in their original order (stable)", () => {
    const rows = [
      { id: "a", last_reminder_sent_at: null },
      { id: "b", last_reminder_sent_at: null },
    ];
    expect([...rows].sort(byLeastRecentlyReminded).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
