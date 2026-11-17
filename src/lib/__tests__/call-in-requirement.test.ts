import { describe, it, expect } from "vitest";
import { describeCallInRequirement, callInLeadName } from "../call-in-requirement";

describe("describeCallInRequirement", () => {
  it("writes every choice the caller made, in words", () => {
    const text = describeCallInRequirement({
      locations: ["Koramangala", "HSR Layout"],
      types: ["dedicated_desk", "hot_desk"],
      seats: 4,
      startDate: "2026-12-01",
      quotedPerSeat: 12500,
      budgetPerSeat: 10000,
      requests: "  Near a metro  ",
    });
    expect(text).toBe(
      [
        "Looking at: Koramangala, HSR Layout",
        "Wants: Dedicated Desk, Hot Desk · 4 seats from 2026-12-01",
        "Quoted ₹12,500/seat/month · Budget ₹10,000/seat/month",
        "Other requests: Near a metro",
      ].join("\n"),
    );
  });

  it("leaves out what was not given", () => {
    const text = describeCallInRequirement({ locations: ["HSR Layout"], types: ["private_office"], seats: 1 });
    expect(text).toBe("Looking at: HSR Layout\nWants: Private Office/Cabin · 1 seat");
  });
});

describe("callInLeadName", () => {
  it("splits a given name", () => {
    expect(callInLeadName({ name: "Ravi Kumar Shah" })).toEqual({ first_name: "Ravi", last_name: "Kumar Shah" });
    expect(callInLeadName({ name: "Ravi" })).toEqual({ first_name: "Ravi", last_name: undefined });
  });

  it("names a nameless caller from how to reach them", () => {
    expect(callInLeadName({ phone: "98450 12345" })).toEqual({ first_name: "Caller", last_name: "98450 12345" });
    expect(callInLeadName({ email: "a@b.test" })).toEqual({ first_name: "Caller", last_name: "a@b.test" });
  });
});
