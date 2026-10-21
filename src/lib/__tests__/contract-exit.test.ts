import { describe, it, expect } from "vitest";
import { canCompleteOn, computeSettlement, daysBetween, isEarlyExit, istDateOf, validateExitDates } from "../contract-exit";

describe("isEarlyExit", () => {
  it("is early only when the last day is before the contract end", () => {
    expect(isEarlyExit("2026-11-02", "2027-03-31")).toBe(true);
    expect(isEarlyExit("2027-03-31", "2027-03-31")).toBe(false);
    expect(isEarlyExit("2027-04-05", "2027-03-31")).toBe(false);
    expect(isEarlyExit("2026-11-02", null)).toBe(false);
  });
});

describe("validateExitDates", () => {
  it("rejects a last day before the notice", () => {
    expect(validateExitDates("2026-10-03", "2026-10-02")).toEqual({ ok: false, error: "The last day can't be before the notice date." });
    expect(validateExitDates("2026-10-03", "2026-10-03")).toEqual({ ok: true });
    expect(validateExitDates("bad", "2026-10-03").ok).toBe(false);
  });
});

describe("canCompleteOn", () => {
  it("opens on the last day in IST, not before", () => {
    expect(canCompleteOn("2026-11-02", new Date("2026-11-01T17:00:00Z"))).toBe(false); // 22:30 IST on 1 Nov
    expect(canCompleteOn("2026-11-02", new Date("2026-11-01T19:00:00Z"))).toBe(true);  // 00:30 IST on 2 Nov
  });
  it("uses IST calendar days", () => {
    expect(istDateOf(new Date("2026-11-01T19:00:00Z"))).toBe("2026-11-02");
    expect(daysBetween("2026-10-03", "2026-11-02")).toBe(30);
  });
});

describe("computeSettlement", () => {
  it("refunds what is left of the deposit", () => {
    const s = computeSettlement({ depositAvailable: 100000, charges: 16700, unpaidInvoices: 14160, unbilledUsage: 2360 });
    expect(s.totalDeductions).toBe(33220);
    expect(s.refund).toBe(66780);
    expect(s.customerOwes).toBe(0);
  });
  it("reports a shortfall when deductions exceed the deposit", () => {
    const s = computeSettlement({ depositAvailable: 30000, charges: 26000, unpaidInvoices: 14160, unbilledUsage: 0 });
    expect(s.refund).toBe(0);
    expect(s.customerOwes).toBe(10160);
  });
  it("is exactly zero both ways when it nets out", () => {
    const s = computeSettlement({ depositAvailable: 5000, charges: 5000, unpaidInvoices: 0, unbilledUsage: 0 });
    expect(s.refund).toBe(0);
    expect(s.customerOwes).toBe(0);
  });
  it("avoids float drift", () => {
    const s = computeSettlement({ depositAvailable: 100, charges: 0.1, unpaidInvoices: 0.2, unbilledUsage: 0 });
    expect(s.refund).toBe(99.7);
  });
});

import { exitDepositAvailable, ownDepositRemaining, reservedForContract } from "../contract-exit";

const dep = (o: Partial<{ amt: number | null; status: string | null; paid: number | null; refunded: number | null; pool: number | null }> = {}) => ({
  security_deposit_amount: o.amt ?? 0,
  deposit_payment_status: o.status ?? "paid",
  deposit_payment_amount: o.paid ?? null,
  deposit_refunded_amount: o.refunded ?? null,
  deposit_pool_applied_amount: o.pool ?? null,
});

describe("pooled deposit protection", () => {
  it("counts only a paid deposit, less what was already refunded", () => {
    expect(ownDepositRemaining(dep({ amt: 50000 }))).toBe(50000);
    expect(ownDepositRemaining(dep({ amt: 50000, status: "pending" }))).toBe(0);
    expect(ownDepositRemaining(dep({ amt: 50000, paid: 40000, refunded: 10000 }))).toBe(30000);
  });
  it("reserves what another live contract still needs from the pool", () => {
    expect(reservedForContract(dep({ amt: 50000 }))).toBe(0); // paid its own
    expect(reservedForContract(dep({ amt: 50000, status: "pending" }))).toBe(50000);
    expect(reservedForContract(dep({ amt: 50000, status: "pending", pool: 20000 }))).toBe(50000);
    expect(reservedForContract(dep({ amt: 0, status: "not_required", pool: 20000 }))).toBe(20000);
  });
  it("never lets an exit settle more than the contract holds or the pool leaves free", () => {
    expect(exitDepositAvailable(100000, 50000, 0)).toBe(50000); // two paid deposits: only its own
    expect(exitDepositAvailable(50000, 50000, 50000)).toBe(0);  // other contract relies on it all
    expect(exitDepositAvailable(80000, 50000, 50000)).toBe(30000);
    expect(exitDepositAvailable(0, 50000, 0)).toBe(0);
  });
});
