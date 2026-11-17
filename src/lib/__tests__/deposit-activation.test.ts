import { describe, expect, it } from "vitest";
import { partialDepositState, partialDepositWarning } from "../deposit-activation";

describe("partialDepositState", () => {
  it("allows activation only when MORE than half is received", () => {
    expect(partialDepositState(40000, 20001).allowsActivation).toBe(true);
    expect(partialDepositState(40000, 20000).allowsActivation).toBe(false); // exactly 50% is not more than 50%
    expect(partialDepositState(40000, 9000).allowsActivation).toBe(false);
  });

  it("a complete deposit is the normal case, not a partial one", () => {
    const s = partialDepositState(40000, 40000);
    expect(s.complete).toBe(true);
    expect(s.allowsActivation).toBe(false);
    expect(s.pending).toBe(0);
  });

  it("reports pending and percent from money received", () => {
    const s = partialDepositState(60000, 40000);
    expect(s).toMatchObject({ pending: 20000, percent: 66.7, allowsActivation: true });
  });

  it("never activates when nothing is required or nothing is paid", () => {
    expect(partialDepositState(0, 0).allowsActivation).toBe(false);
    expect(partialDepositState(40000, 0).allowsActivation).toBe(false);
  });

  it("is exact on paise: 50.01% passes, 49.99% does not", () => {
    expect(partialDepositState(100, 50.01).allowsActivation).toBe(true);
    expect(partialDepositState(100, 49.99).allowsActivation).toBe(false);
  });

  it("writes a warning with all three figures", () => {
    const w = partialDepositWarning(partialDepositState(40000, 30000));
    expect(w).toContain("₹30,000 of ₹40,000");
    expect(w).toContain("75%");
    expect(w).toContain("₹10,000");
  });
});
