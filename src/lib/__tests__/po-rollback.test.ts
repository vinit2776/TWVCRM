import { describe, it, expect } from "vitest";
import { amcStatusFor, poStatusAfterCancelRestore, poStatusAfterUnmarkReceived } from "../procurement/po-rollback";

const full = [{ quantity_ordered: 10, quantity_received: 10 }];
const part = [{ quantity_ordered: 10, quantity_received: 4 }];
const none = [{ quantity_ordered: 10, quantity_received: 0 }];

describe("poStatusAfterCancelRestore", () => {
  it("uses the status stored at cancel time", () => {
    expect(poStatusAfterCancelRestore("ordered", none)).toBe("ordered");
    expect(poStatusAfterCancelRestore("received", part)).toBe("received");
  });

  it("derives for POs cancelled before the status was recorded", () => {
    expect(poStatusAfterCancelRestore(null, full)).toBe("received");
    expect(poStatusAfterCancelRestore(null, part)).toBe("partially_received");
  });

  it("falls back to pending when nothing was received", () => {
    expect(poStatusAfterCancelRestore(null, none)).toBe("pending");
    expect(poStatusAfterCancelRestore(null, [])).toBe("pending");
  });

  it("ignores a stored status that is not a restorable one", () => {
    expect(poStatusAfterCancelRestore("invoice_received", none)).toBe("pending");
    expect(poStatusAfterCancelRestore("cancelled", part)).toBe("partially_received");
  });
});

describe("poStatusAfterUnmarkReceived", () => {
  it("refuses when the receipts really do cover the order", () => {
    expect(poStatusAfterUnmarkReceived(full)).toBeNull();
  });

  it("falls back to what the receipts support", () => {
    expect(poStatusAfterUnmarkReceived(part)).toBe("partially_received");
    expect(poStatusAfterUnmarkReceived(none)).toBe("ordered");
    expect(poStatusAfterUnmarkReceived([])).toBe("ordered");
  });
});

describe("amcStatusFor", () => {
  const today = new Date("2026-10-16");
  const base = { start: "2026-01-01", end: "2027-01-01", visitsCovered: 4, visitsUsed: 1, today };

  it("is active mid-contract", () => {
    expect(amcStatusFor({ ...base, end: "2027-06-01" })).toBe("active");
  });
  it("is inactive before the start date or with no start", () => {
    expect(amcStatusFor({ ...base, start: "2026-12-01" })).toBe("inactive");
    expect(amcStatusFor({ ...base, start: null })).toBe("inactive");
  });
  it("is expired after the end date", () => {
    expect(amcStatusFor({ ...base, end: "2026-09-01" })).toBe("expired");
  });
  it("is exhausted once the covered visits are used", () => {
    expect(amcStatusFor({ ...base, end: "2027-06-01", visitsUsed: 4 })).toBe("exhausted");
  });
  it("is expiring within 60 days of the end", () => {
    expect(amcStatusFor({ ...base, end: "2026-11-20" })).toBe("expiring");
  });
  it("is active with no end date and no visit limit", () => {
    expect(amcStatusFor({ ...base, end: null, visitsCovered: null })).toBe("active");
  });
});
