import { describe, it, expect } from "vitest";
import {
  buildCommitmentTermLines,
  composeProposalTerms,
  maxNoticePeriodMonths,
  mentionsCommitmentTerms,
  stripLegacyCommitmentLines,
  validateCommitmentTerms,
} from "../proposal-terms";
import { DEFAULT_PROPOSAL_TERMS } from "../constants";

const standard = {
  tenure_months: 12,
  lock_in_months: 11,
  notice_period_months: 2,
  security_deposit_months: 2,
  security_deposit_amount: 64000,
};

describe("validateCommitmentTerms", () => {
  it("accepts a consistent set", () => {
    expect(validateCommitmentTerms(standard)).toBeNull();
  });

  it("requires every field", () => {
    expect(validateCommitmentTerms({ ...standard, tenure_months: null })).toMatch(/term/i);
    expect(validateCommitmentTerms({ ...standard, lock_in_months: undefined })).toMatch(/lock-in/i);
    expect(validateCommitmentTerms({ ...standard, notice_period_months: null })).toMatch(/notice/i);
  });

  it("rejects a lock-in longer than the term", () => {
    expect(validateCommitmentTerms({ ...standard, tenure_months: 6, lock_in_months: 11 })).toMatch(/lock-in/i);
  });

  it("caps notice at max(3, term - lock-in), matching the contract forms", () => {
    expect(maxNoticePeriodMonths(12, 11)).toBe(3);
    expect(maxNoticePeriodMonths(18, 6)).toBe(12);
    expect(validateCommitmentTerms({ ...standard, notice_period_months: 4 })).toMatch(/notice/i);
    expect(validateCommitmentTerms({ ...standard, notice_period_months: 0 })).toBeNull();
  });
});

describe("buildCommitmentTermLines", () => {
  it("renders the selected values", () => {
    expect(buildCommitmentTermLines(standard)).toEqual([
      "• 2 months rent payable as an interest free refundable security deposit of Rs. 64,000",
      "• Term 12 months (Lock-in 11 months)",
      "• Notice period 2 months post lock-in",
    ]);
  });

  it("handles singulars, a waived deposit and no notice", () => {
    expect(
      buildCommitmentTermLines({ tenure_months: 1, lock_in_months: 1, notice_period_months: 0, security_deposit_months: 0 })
    ).toEqual(["• No security deposit", "• Term 1 month (Lock-in 1 month)", "• No notice period post lock-in"]);
  });

  it("returns nothing for legacy proposals without structured terms", () => {
    expect(buildCommitmentTermLines({ security_deposit_months: 3 })).toEqual([]);
  });
});

describe("composeProposalTerms", () => {
  it("puts generated lines before the free text", () => {
    expect(composeProposalTerms({ ...standard, terms_and_conditions: "• Taxes as applicable" })).toBe(
      [...buildCommitmentTermLines(standard), "• Taxes as applicable"].join("\n")
    );
  });

  it("leaves a legacy proposal's stored text exactly as sent", () => {
    const legacy = "• Term 1 year (Lock-in 11 months)\n• Taxes as applicable";
    expect(composeProposalTerms({ terms_and_conditions: legacy })).toBe(legacy);
  });
});

describe("legacy static lines", () => {
  const oldDefault = `• Taxes as applicable
• 3 months rent payable as an interest free refundable security deposit
• Advance monthly rent payable on or before 5th of every month
• Term 1 year (Lock-in 11 months)
• Notice period 2 months post lock-in
• Center timing Monday - Saturday 9AM to 7PM`;

  it("also strips a deposit line that carries an amount", () => {
    expect(
      stripLegacyCommitmentLines("• Taxes as applicable\n• 3 months rent payable as an interest free refundable security deposit of Rs. 36,000")
    ).toBe("• Taxes as applicable");
  });

  it("strips only the deposit/term/notice lines from the old default", () => {
    expect(stripLegacyCommitmentLines(oldDefault)).toBe(`• Taxes as applicable
• Advance monthly rent payable on or before 5th of every month
• Center timing Monday - Saturday 9AM to 7PM`);
  });

  it("the new default no longer mentions the generated terms", () => {
    expect(mentionsCommitmentTerms(DEFAULT_PROPOSAL_TERMS)).toBe(false);
    expect(mentionsCommitmentTerms(oldDefault)).toBe(true);
  });
});
