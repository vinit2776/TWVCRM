import { describe, it, expect } from "vitest";
import {
  allocationSummary,
  checkJoin,
  checkTotalAgainstPos,
  invoiceNumberKey,
  sharedInvoiceApprovalError,
} from "../procurement/shared-invoice";

describe("invoiceNumberKey", () => {
  it("ignores case and spacing", () => {
    expect(invoiceNumberKey(" BI/2026/0412 ")).toBe(invoiceNumberKey("bi/2026/0412"));
    expect(invoiceNumberKey("BI 2026 / 0412")).toBe("bi2026/0412");
  });
  it("keeps genuinely different numbers apart", () => {
    expect(invoiceNumberKey("INV-412")).not.toBe(invoiceNumberKey("INV-0412"));
  });
});

describe("allocationSummary", () => {
  it("reports what is allocated and what is left", () => {
    expect(allocationSummary(200000, [120000])).toEqual({ allocated: 120000, left: 80000 });
  });
  it("never reports a negative balance", () => {
    expect(allocationSummary(100, [150]).left).toBe(0);
  });
});

describe("checkJoin", () => {
  const base = { currentTotal: 200000, newTotal: 200000, otherShares: [120000], share: 80000, poValues: [120000, 100000] };

  it("accepts a share that fits the invoice", () => {
    expect(checkJoin(base).ok).toBe(true);
  });

  it("rejects a share over what is left", () => {
    const r = checkJoin({ ...base, share: 110000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("OVER_ALLOCATED");
  });

  it("allows raising the total when the first bill held only its own share", () => {
    const r = checkJoin({ currentTotal: 120000, newTotal: 200000, otherShares: [120000], share: 80000, poValues: [120000, 100000] });
    expect(r.ok).toBe(true);
  });

  it("does not let the total go down", () => {
    const r = checkJoin({ ...base, newTotal: 150000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOTAL_CANNOT_DROP");
  });

  it("rejects a total above the combined PO value", () => {
    const r = checkJoin({ ...base, currentTotal: 120000, newTotal: 260000, poValues: [120000, 100000] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TOTAL_OVER_PO_VALUE");
  });

  it("allows a rounding difference of a paisa or two", () => {
    expect(checkJoin({ ...base, share: 80000.01 }).ok).toBe(true);
  });
});

describe("checkTotalAgainstPos", () => {
  it("is not judged with a single PO", () => {
    expect(checkTotalAgainstPos(200000, [120000])).toBeNull();
  });
  it("passes at exactly the combined value", () => {
    expect(checkTotalAgainstPos(220000, [120000, 100000])).toBeNull();
  });
});

describe("sharedInvoiceApprovalError", () => {
  it("lets a healthy shared invoice through, even with an unallocated remainder", () => {
    expect(sharedInvoiceApprovalError({ invoiceTotal: 200000, shares: [120000], poValues: [120000] })).toBeNull();
  });
  it("blocks when shares exceed the invoice", () => {
    expect(sharedInvoiceApprovalError({ invoiceTotal: 200000, shares: [120000, 90000], poValues: [120000, 100000] })).toMatch(/more than the invoice total/);
  });
  it("blocks when the invoice outgrew its POs", () => {
    expect(sharedInvoiceApprovalError({ invoiceTotal: 300000, shares: [120000, 80000], poValues: [120000, 100000] })).toMatch(/combined value/);
  });
});
