import { describe, expect, it } from "vitest";
import { voRepriceBlockedReason, voRepricedTotals } from "@/lib/vo-proposal";

describe("voRepriceBlockedReason", () => {
  it("allows an unsent VO draft", () => {
    expect(voRepriceBlockedReason({ kind: "virtual_office", status: "draft" })).toBeNull();
  });
  it.each(["sent", "viewed", "accepted", "declined", "expired", "withdrawn", "changes_requested", "superseded"])("blocks %s", (status) => {
    expect(voRepriceBlockedReason({ kind: "virtual_office", status })).toMatch(/\S/);
  });
  it("blocks regular proposals", () => {
    expect(voRepriceBlockedReason({ kind: "standard", status: "draft" })).toMatch(/Virtual Office/);
  });
  it("blocks once money is collected", () => {
    expect(voRepriceBlockedReason({ kind: "virtual_office", status: "draft", payment_status: "paid" })).toMatch(/Money/);
  });
});

describe("voRepricedTotals", () => {
  it("uses the rate as the fee up to 12 months", () => {
    const t = voRepricedTotals(10000, 12, 18, 0);
    expect(t.subtotal).toBe(10000);
    expect(t.total).toBe(11800);
  });
  it("treats the rate as annual above 12 months", () => {
    const t = voRepricedTotals(10000, 36, 18, 10);
    expect(t.subtotal).toBe(30000);
    expect(t.items[0].unit_price).toBe(30000);
    expect(t.total).toBe(30000 + 5400 - 3000);
  });
});
