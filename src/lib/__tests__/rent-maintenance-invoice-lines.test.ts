import { describe, it, expect } from "vitest";
import { fixedShareOfItems, splitByShare } from "../rent-maintenance-split";
import { buildSegmentedRentLineItems } from "../billing";
import { buildProrataLineItems, computeProrataAmounts } from "../prorata-correction";

const TWV_0156_ITEMS = [
  { total: 219820.8, escalates: true },
  { total: 28800, escalates: false },
];

describe("fixedShareOfItems", () => {
  it("is 0 for legacy lines, all-escalating and all-fixed contracts", () => {
    expect(fixedShareOfItems(null)).toBe(0);
    expect(fixedShareOfItems([{ total: 1000 }])).toBe(0);
    expect(fixedShareOfItems([{ total: 1000, escalates: true }])).toBe(0);
    expect(fixedShareOfItems([{ total: 1000, escalates: false }])).toBe(0);
  });
  it("is the fixed fraction of the monthly rate", () => {
    expect(fixedShareOfItems(TWV_0156_ITEMS)).toBeCloseTo(28800 / 248620.8, 10);
  });
});

describe("splitByShare", () => {
  it("always sums back to the original amount", () => {
    for (const amount of [224560.72, 100, 0.03, 267130.54, 12345.67]) {
      const { rent, maintenance } = splitByShare(amount, 28800 / 248620.8);
      expect(Math.round((rent + maintenance) * 100) / 100).toBe(amount);
    }
  });
  it("is a no-op without a share", () => {
    expect(splitByShare(500, 0)).toEqual({ rent: 500, maintenance: 0 });
  });
});

describe("monthly rent lines with a fixed component", () => {
  const share = 28800 / 248620.8;
  const full = [{ start: "2026-11-01", end: "2026-11-30", days: 30, rate: 248620.8, amount: 248620.8 }];

  it("shows rent and maintenance as separate lines that add up to the segment", () => {
    const items = buildSegmentedRentLineItems(full, 1, [], "Staging Test Location", "Nov26", 30, false, share);
    expect(items).toHaveLength(2);
    expect(items[0].description).toContain("Monthly rent");
    expect(items[1].description).toBe("Maintenance | Nov26");
    expect(Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100).toBe(248620.8);
    for (const i of items) expect(Math.round(i.qty * i.unit_price * 100) / 100).toBeCloseTo(i.amount, 2);
    expect(items[1].amount).toBe(28800);
  });

  it("is identical to today's output when there is no fixed component", () => {
    const a = buildSegmentedRentLineItems(full, 1, [], "Staging Test Location", "Nov26", 30, false);
    const b = buildSegmentedRentLineItems(full, 1, [], "Staging Test Location", "Nov26", 30, false, 0);
    expect(b).toEqual(a);
    expect(a).toHaveLength(1);
    expect(a[0].amount).toBe(248620.8);
  });

  it("prorates both lines on the same days and keeps the total", () => {
    const part = [{ start: "2026-11-14", end: "2026-11-30", days: 17, rate: 248620.8, amount: 140885.12 }];
    const items = buildSegmentedRentLineItems(part, 1, [], null, "Nov26", 30, false, share);
    expect(Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100).toBe(140885.12);
    expect(items.every((i) => i.days_used === 17 && i.days_in_month === 30)).toBe(true);
    expect(items[0].monthly_rate! + items[1].monthly_rate!).toBeCloseTo(248620.8, 2);
  });

  it("keeps maintenance as ONE line when the rent is split across rooms", () => {
    const rooms = [
      { locationName: "A", name: "Cabin 1", type: "cabin", capacity: 2 },
      { locationName: "A", name: "Cabin 2", type: "cabin", capacity: 2 },
    ] as unknown as Parameters<typeof buildSegmentedRentLineItems>[2];
    const items = buildSegmentedRentLineItems(full, 4, rooms, null, "Nov26", 30, false, share);
    expect(items.filter((i) => i.description.startsWith("Maintenance"))).toHaveLength(1);
    expect(Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100).toBe(248620.8);
  });
});

describe("pro-rata statement lines", () => {
  const share = fixedShareOfItems(TWV_0156_ITEMS);
  const amounts = computeProrataAmounts({ monthlySubtotal: 248620.8, startDate: "2026-10-04", taxPercentage: 18, isInterstate: false });

  it("TWV-C-0156 October: two lines summing to 224,560.72", () => {
    const [group] = buildProrataLineItems({ startDate: "2026-10-04", prorataSubtotal: amounts.subtotal, monthlySubtotal: 248620.8, fixedShare: share });
    expect(group.items.map((i) => i.description)).toEqual(["Pro-Rata Workspace Fee (Oct 4–31)", "Pro-Rata Maintenance (Oct 4–31)"]);
    const [rent, maint] = group.items as Array<{ amount: number; quantity: number; unit_price: number }>;
    expect(Math.round((rent.amount + maint.amount) * 100) / 100).toBe(224560.72);
    expect(maint.amount).toBeCloseTo(26012.9, 1);
    expect(group.subtotal).toBe(224560.72);
    for (const i of [rent, maint]) expect(i.quantity * i.unit_price).toBeCloseTo(i.amount, 2);
  });

  it("is the single line as before when nothing is fixed", () => {
    const [group] = buildProrataLineItems({ startDate: "2026-10-04", prorataSubtotal: 226381.81, monthlySubtotal: 250637, fixedShare: 0 });
    expect(group.items).toHaveLength(1);
    expect(group.items[0]).toMatchObject({ amount: 226381.81, monthly_rate: 250637, days_used: 28, days_in_month: 31 });
  });
});
