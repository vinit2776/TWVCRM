import { describe, it, expect } from "vitest";
import { syncDepositTerm } from "../proposal-deposit-terms";
import { DEFAULT_PROPOSAL_TERMS } from "../constants";

const DEPOSIT_3 = "• 3 months rent payable as an interest free refundable security deposit of Rs. 36,000";

describe("syncDepositTerm", () => {
  it("rewrites the legacy static line with the selected months and amount", () => {
    const r = syncDepositTerm(DEFAULT_PROPOSAL_TERMS, 2, 24000);
    expect(r).toContain("• 2 months rent payable as an interest free refundable security deposit of Rs. 24,000");
    expect(r).not.toContain("3 months rent");
    expect(r.split("\n")).toHaveLength(DEFAULT_PROPOSAL_TERMS.split("\n").length);
  });

  it("uses the singular for one month", () => {
    expect(syncDepositTerm(DEFAULT_PROPOSAL_TERMS, 1, 12000)).toContain("• 1 month rent payable");
  });

  it("formats amounts in Indian grouping", () => {
    expect(syncDepositTerm(DEFAULT_PROPOSAL_TERMS, 6, 150000)).toContain("of Rs. 1,50,000");
  });

  it("removes the line when there is no deposit, leaving other lines untouched", () => {
    const r = syncDepositTerm(DEFAULT_PROPOSAL_TERMS, 0, 0);
    expect(r).not.toMatch(/security deposit/i);
    expect(r.split("\n")).toHaveLength(DEFAULT_PROPOSAL_TERMS.split("\n").length - 1);
    expect(r.startsWith("• Taxes as applicable\n• Advance monthly rent")).toBe(true);
  });

  it("re-inserts the line after 'Taxes as applicable' when a deposit is picked again", () => {
    const removed = syncDepositTerm(DEFAULT_PROPOSAL_TERMS, 0, 0);
    const r = syncDepositTerm(removed, 3, 36000);
    expect(r.split("\n")[1]).toBe(DEPOSIT_3);
  });

  it("inserts at the top when there is no taxes line", () => {
    const r = syncDepositTerm("- Term 1 year", 3, 36000);
    expect(r).toBe("- 3 months rent payable as an interest free refundable security deposit of Rs. 36,000\n- Term 1 year");
  });

  it("is stable when run repeatedly with the same values", () => {
    const once = syncDepositTerm(DEFAULT_PROPOSAL_TERMS, 3, 36000);
    expect(syncDepositTerm(once, 3, 36000)).toBe(once);
  });

  it("updates an amount it previously wrote", () => {
    const once = syncDepositTerm(DEFAULT_PROPOSAL_TERMS, 3, 36000);
    expect(syncDepositTerm(once, 3, 40000)).toContain("security deposit of Rs. 40,000");
  });

  it("leaves a reworded deposit line alone and does not add a second one", () => {
    const custom = "• Taxes as applicable\n• Security deposit of two months, payable before move-in";
    expect(syncDepositTerm(custom, 3, 36000)).toBe(custom);
    expect(syncDepositTerm(custom, 0, 0)).toBe(custom);
  });

  it("writes just the deposit line into empty terms", () => {
    expect(syncDepositTerm("", 3, 36000)).toBe(DEPOSIT_3);
    expect(syncDepositTerm("", 0, 0)).toBe("");
  });
});
