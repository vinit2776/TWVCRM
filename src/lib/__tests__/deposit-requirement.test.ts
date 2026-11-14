import { describe, expect, it } from "vitest";
import { contractDepositRequirement, depositShortfall } from "../deposit-requirement";

describe("contractDepositRequirement", () => {
  it("uses the activated contract's own snapshot when there is one", () => {
    expect(contractDepositRequirement({ status: "active", security_deposit_amount: 70000, security_deposit_months: 2, subtotal: 33108 })).toBe(70000);
  });

  it("falls back to months x fee for a carried-forward renewal with no snapshot", () => {
    expect(contractDepositRequirement({ status: "active", security_deposit_amount: 0, security_deposit_months: 2, subtotal: 33108 })).toBe(66216);
  });

  it("counts a live contract mid-renewal the same way", () => {
    expect(contractDepositRequirement({ status: "renewal_in_progress", security_deposit_amount: null, security_deposit_months: 2, subtotal: 31532 })).toBe(63064);
  });

  it("is zero when the deposit is waived", () => {
    expect(contractDepositRequirement({ status: "active", security_deposit_amount: 0, security_deposit_months: 0, subtotal: 33108 })).toBe(0);
  });

  it("uses the proposal's figure before activation", () => {
    expect(contractDepositRequirement({ status: "draft", security_deposit_amount: 0, security_deposit_months: 3, subtotal: 10000 }, 30000)).toBe(30000);
  });
});

describe("depositShortfall", () => {
  it("is required minus available, as on Acko's renewal", () => {
    expect(depositShortfall(66216, 52000)).toBe(14216);
  });

  it("never goes negative when the pool holds more than is required", () => {
    expect(depositShortfall(40000, 52000)).toBe(0);
  });
});
