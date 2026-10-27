import { describe, it, expect } from "vitest";
import { buildTimeline, summarizePeople, isNoise, entrySummary, type TimelineRow } from "../procurement/audit-timeline";
import { summarizeAuditEvent } from "../audit-labels";

let n = 0;
const row = (over: Partial<TimelineRow> & { at: string; by?: string }): TimelineRow => ({
  id: `r${++n}`,
  entity_type: "purchase_request",
  entity_id: "mr1",
  action: "update",
  changes: { notes: { old: "a", new: "b" } },
  created_at: `2026-10-01T${over.at}:00Z`,
  performer: { id: over.by ?? "u1", full_name: over.by ?? "Aruna", role: "coordinator" },
  ...over,
});

describe("summarizeAuditEvent edits", () => {
  it("falls back to a plain Edited", () => {
    const s = summarizeAuditEvent({ entity_type: "purchase_request", action: "update", changes: { notes: { old: 1, new: 2 } } });
    expect(s.label).toBe("Edited");
    expect(s.kind).toBe("edit");
  });
  it("labels and flags amount changes", () => {
    const s = summarizeAuditEvent({ entity_type: "purchase_order", action: "update", changes: { total_ordered_amount: { old: 100, new: 150 } } });
    expect(s.label).toBe("Amount changed");
    expect(s.flag).toBe(true);
    expect(s.detail).toBe("₹100 → ₹150");
  });
  it("labels vendor and item changes", () => {
    expect(summarizeAuditEvent({ entity_type: "purchase_order", action: "update", changes: { vendor_id: { old: "a", new: "b" } } }).label).toBe("Vendor changed");
    expect(summarizeAuditEvent({ entity_type: "purchase_request", action: "update", changes: { line_items: { old: "2 item(s)", new: "3 item(s)" } } }).label).toBe("Items changed");
  });
  it("drops the detail when an items change shows the same count on both sides", () => {
    const s = summarizeAuditEvent({ entity_type: "purchase_request", action: "update", changes: { line_items: { old: "2 item(s)", new: "2 item(s)" } } });
    expect(s.label).toBe("Items changed");
    expect(s.detail).toBeUndefined();
  });
  it("keeps goods received as a milestone", () => {
    const s = summarizeAuditEvent({ entity_type: "purchase_order", action: "update", changes: { status: { old: "ordered", new: "received" } } });
    expect(s.label).toBe("Goods received");
    expect(s.kind).toBeUndefined();
  });
});

describe("isNoise", () => {
  it("drops edits that only touched bookkeeping keys or nothing", () => {
    expect(isNoise(entrySummary(row({ at: "10:00", changes: { updated_at: { old: 1, new: 2 }, updated_by: { old: 1, new: 2 } } })))).toBe(true);
    expect(isNoise(entrySummary(row({ at: "10:00", changes: {} })))).toBe(true);
    expect(isNoise(entrySummary(row({ at: "10:00", changes: null })))).toBe(true);
    expect(isNoise(entrySummary(row({ at: "10:00", action: "view", changes: {} })))).toBe(true);
  });
  it("keeps real edits and milestones", () => {
    expect(isNoise(entrySummary(row({ at: "10:00" })))).toBe(false);
    expect(isNoise(entrySummary(row({ at: "10:00", action: "create", changes: {} })))).toBe(false);
  });
});

describe("buildTimeline", () => {
  it("groups consecutive edits inside the window and never groups milestones", () => {
    const rows = [
      row({ at: "10:00", by: "Aruna" }),
      row({ at: "10:10", by: "Noorul" }),
      row({ at: "10:12", action: "create", changes: {} }),
      row({ at: "10:15", by: "Aruna" }),
    ];
    const items = buildTimeline(rows, "key");
    expect(items.map((i) => i.type)).toEqual(["edit_group", "milestone", "edit"]);
    const g = items[0];
    if (g.type !== "edit_group") throw new Error();
    expect(g.entries).toHaveLength(2);
    expect(g.people).toEqual(["Aruna", "Noorul"]);
  });
  it("starts a new group after a gap over 30 minutes or an entity change", () => {
    const rows = [
      row({ at: "10:00" }),
      row({ at: "10:05" }),
      row({ at: "11:00" }),
      row({ at: "11:05", entity_type: "purchase_order" }),
    ];
    expect(buildTimeline(rows, "key").map((i) => i.type)).toEqual(["edit_group", "edit", "edit"]);
  });
  it("hides noise in key view but All activity keeps every row", () => {
    const rows = [row({ at: "10:00", changes: { updated_at: { old: 1, new: 2 } } }), row({ at: "10:01", action: "create", changes: {} })];
    expect(buildTimeline(rows, "key")).toHaveLength(1);
    expect(buildTimeline(rows, "all")).toHaveLength(2);
  });
  it("stage filters narrow by entity", () => {
    const rows = [row({ at: "10:00", action: "create", changes: {} }), row({ at: "10:01", entity_type: "vendor_bill", action: "create", changes: {} })];
    expect(buildTimeline(rows, "invoice")).toHaveLength(1);
  });
});

describe("summarizePeople", () => {
  it("joins names", () => {
    expect(summarizePeople(["A", "A"])).toBe("A");
    expect(summarizePeople(["A", "B"])).toBe("A and B");
    expect(summarizePeople(["A", "B", "C", "D"])).toBe("A, B and 2 others");
  });
});
