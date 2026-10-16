import { describe, it, expect } from "vitest";
import { OVERPAYMENT_CODE, overpaymentMessage } from "../overpayment-guard";

describe("overpaymentMessage", () => {
  it("tells accounts the invoice is already paid, and to link the existing receipt", () => {
    const m = overpaymentMessage({ outstanding: 0, settled: 6372, attempted: 6372 });
    expect(m).toContain("already fully paid");
    expect(m).toContain("link the existing payment");
  });

  it("says how much is still due when the invoice is only partly paid", () => {
    const m = overpaymentMessage({ outstanding: 3000, settled: 3372, attempted: 6372 });
    expect(m).toContain("3,000");
    expect(m).toContain("6,372");
    expect(m).not.toContain("fully paid");
  });

  it("exposes a stable code for callers", () => {
    expect(OVERPAYMENT_CODE).toBe("OVERPAYMENT");
  });
});
