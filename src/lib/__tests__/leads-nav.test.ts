import { describe, it, expect } from "vitest";
import { buildLeadsNav, groupCount } from "../leads-nav";

const counts = { enquiries: 3, followups: 12, tours: 2, replies: 4 };
const state = { view: "all" as const, pinnedOnly: false, statusFilter: "" };
const all = (n: ReturnType<typeof buildLeadsNav>) => [...n.daily, ...n.menus.flatMap((m) => m.items)];

describe("buildLeadsNav", () => {
  it("has three daily tabs and the Buckets and Reports menus", () => {
    const nav = buildLeadsNav(state, counts);
    expect(nav.daily.map((i) => i.label)).toEqual(["New enquiries", "Follow-ups", "Tours"]);
    expect(nav.menus.map((m) => m.label)).toEqual(["Buckets", "Reports"]);
  });

  it("marks exactly one entry current for each place the page can be", () => {
    const cases: [Parameters<typeof buildLeadsNav>[0], string][] = [
      [{ view: "enquiries", pinnedOnly: false, statusFilter: "" }, "enquiries"],
      [{ view: "followups", pinnedOnly: false, statusFilter: "" }, "followups"],
      [{ view: "tours", pinnedOnly: false, statusFilter: "" }, "tours"],
      [{ view: "replies", pinnedOnly: false, statusFilter: "" }, "replies"],
      [{ view: "whatsapp", pinnedOnly: false, statusFilter: "" }, "whatsapp"],
      [{ view: "all", pinnedOnly: false, statusFilter: "" }, "all"],
      [{ view: "all", pinnedOnly: true, statusFilter: "" }, "pinned"],
      [{ view: "all", pinnedOnly: false, statusFilter: "junk" }, "junk"],
    ];
    for (const [s, key] of cases) {
      const active = all(buildLeadsNav(s, counts)).filter((i) => i.active).map((i) => i.key);
      expect(active).toEqual([key]);
    }
  });

  it("a status filter other than junk is still All leads", () => {
    const active = all(buildLeadsNav({ ...state, statusFilter: "new" }, counts)).filter((i) => i.active);
    expect(active.map((i) => i.key)).toEqual(["all"]);
  });

  it("carries the counts and rolls them up per menu", () => {
    const nav = buildLeadsNav(state, counts);
    expect(nav.daily.map((i) => i.count)).toEqual([3, 12, 2]);
    expect(groupCount(nav.menus[0])).toBe(4);
    expect(groupCount(nav.menus[1])).toBe(0);
  });
});
