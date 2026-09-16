import { describe, it, expect } from "vitest";
import { STANDARD_DEPOSIT_LINE, depositTermText } from "../proposal-deposit-terms";

describe("depositTermText", () => {
  it("states the selected months and amount", () => {
    expect(depositTermText(2, 24000)).toBe("2 months rent payable as an interest free refundable security deposit of Rs. 24,000");
  });

  it("uses the singular for one month", () => {
    expect(depositTermText(1, 12000)).toContain("1 month rent payable");
  });

  it("formats amounts in Indian grouping", () => {
    expect(depositTermText(6, 150000)).toContain("of Rs. 1,50,000");
  });

  it("omits the amount when it isn't known", () => {
    expect(depositTermText(3, 0)).toBe("3 months rent payable as an interest free refundable security deposit");
  });
});

describe("STANDARD_DEPOSIT_LINE", () => {
  it("recognises the old static line and the amount-bearing line", () => {
    expect(STANDARD_DEPOSIT_LINE.test("• 3 months rent payable as an interest free refundable security deposit")).toBe(true);
    expect(STANDARD_DEPOSIT_LINE.test("• 3 months rent payable as an interest free refundable security deposit of Rs. 36,000")).toBe(true);
  });

  it("does not match reworded deposit terms", () => {
    expect(STANDARD_DEPOSIT_LINE.test("• Security deposit of two months, payable before move-in")).toBe(false);
  });
});
