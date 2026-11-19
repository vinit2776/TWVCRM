import { describe, it, expect } from "vitest";
import { buildPackageStatement, type StatementPurchase, type StatementRedemption, type StatementCancellation } from "../package-statement";

const purchase = (over: Partial<StatementPurchase> = {}): StatementPurchase => ({
  packageName: "Meeting room 10-hour pack",
  creditType: "hours",
  totalCredits: 10,
  creditsUsed: 0,
  pricePaid: 4720,
  purchasedAt: "2026-11-18T05:00:00Z",
  expiresAt: "2026-12-17",
  cancellationWindowHours: 2,
  locations: ["Koramangala"],
  ...over,
});

const red = (id: string, no: string, at: string, credits: number): StatementRedemption => ({
  bookingId: id, bookingNumber: no, redeemedAt: at, creditsDeducted: credits, locationName: "Koramangala",
});

const canc = (over: Partial<StatementCancellation>): StatementCancellation => ({
  bookingId: "b1", createdAt: "2026-11-26T05:00:00Z", trigger: "cancel", outcome: "restored", creditsRestored: 3,
  hoursBeforeStart: 5, windowHours: 2, isOverride: false, overrideReason: null, ...over,
});

describe("buildPackageStatement", () => {
  it("starts with the purchase and deducts each redemption", () => {
    const s = buildPackageStatement(purchase({ creditsUsed: 4 }), [
      red("b1", "BK-1", "2026-11-20T05:00:00Z", 2), red("b2", "BK-2", "2026-11-25T05:00:00Z", 2),
    ], []);
    expect(s.rows.map((r) => r.balance)).toEqual([10, 8, 6]);
    expect(s.balance).toBe(6);
  });

  it("shows a restore with hours before start, the window and the outcome", () => {
    const s = buildPackageStatement(purchase({ creditsUsed: 0 }), [red("b1", "BK-55", "2026-11-26T04:00:00Z", 3)], [canc({})]);
    const row = s.rows[s.rows.length - 1];
    expect(row.tag).toBe("restored");
    expect(row.detail).toBe("Cancelled 5 hrs before start, free cancellation up to 2 hrs. Restored.");
    expect(row.change).toBe(3);
    expect(s.balance).toBe(10);
  });

  it("lists a late cancellation as forfeited with no change to the balance", () => {
    const s = buildPackageStatement(purchase({ creditsUsed: 1 }), [red("b1", "BK-63", "2026-11-28T04:00:00Z", 1)],
      [canc({ outcome: "forfeited", creditsRestored: 0, hoursBeforeStart: 1, createdAt: "2026-11-28T05:00:00Z" })]);
    const row = s.rows[s.rows.length - 1];
    expect(row.tag).toBe("forfeited");
    expect(row.detail).toBe("Cancelled 1 hr before start, free cancellation up to 2 hrs. Not restored.");
    expect(row.change).toBe(0);
    expect(s.balance).toBe(9);
  });

  it("explains a no-show and a package that never restores", () => {
    const noShow = buildPackageStatement(purchase({ creditsUsed: 1 }), [red("b1", "BK-70", "2026-11-29T04:00:00Z", 1)],
      [canc({ trigger: "no_show", outcome: "forfeited", creditsRestored: 0, hoursBeforeStart: -1, createdAt: "2026-11-29T06:00:00Z" })]);
    expect(noShow.rows[noShow.rows.length - 1].detail).toBe("Customer did not attend. Not restored.");

    const never = buildPackageStatement(purchase({ creditsUsed: 1, cancellationWindowHours: null }), [red("b1", "BK-1", "2026-11-20T04:00:00Z", 1)],
      [canc({ outcome: "forfeited", creditsRestored: 0, windowHours: null, createdAt: "2026-11-20T06:00:00Z" })]);
    expect(never.rows[never.rows.length - 1].detail).toContain("does not restore credits");
  });

  it("records a manager override with its reason", () => {
    const s = buildPackageStatement(purchase({ creditsUsed: 0 }), [red("b1", "BK-81", "2026-11-30T04:00:00Z", 2)],
      [canc({ creditsRestored: 2, hoursBeforeStart: 1, isOverride: true, overrideReason: "site access delay", createdAt: "2026-11-30T06:00:00Z" })]);
    const row = s.rows[s.rows.length - 1];
    expect(row.tag).toBe("override");
    expect(row.detail).toBe("Cancelled 1 hr before start, free cancellation up to 2 hrs. Restored by manager override: site access delay.");
  });

  it("shows an adjustment row when the records do not explain the balance", () => {
    const s = buildPackageStatement(purchase({ creditsUsed: 3 }), [red("b1", "BK-1", "2026-11-20T04:00:00Z", 2)], []);
    const last = s.rows[s.rows.length - 1];
    expect(last.entry).toBe("Adjustment");
    expect(last.change).toBe(-1);
    expect(s.balance).toBe(7);
  });

  it("orders a redemption before its cancellation when they share a timestamp", () => {
    const at = "2026-11-26T05:00:00Z";
    const s = buildPackageStatement(purchase({ creditsUsed: 0 }), [red("b1", "BK-9", at, 3)], [canc({ createdAt: at })]);
    expect(s.rows.map((r) => r.entry)).toEqual(["Package purchased", "BK-9 - Koramangala", "BK-9 cancelled"]);
  });

  it("labels units for day packs", () => {
    const s = buildPackageStatement(purchase({ creditType: "days", totalCredits: 5 }), [], []);
    expect(s.unitLabel).toBe("days");
    expect(s.rows[0].detail).toBe("5 days, paid Rs. 4720");
  });
});
