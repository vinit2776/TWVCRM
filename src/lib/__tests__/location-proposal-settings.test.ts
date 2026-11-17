import { describe, it, expect } from "vitest";
import {
  canEditProposalSettings, cleanProposalDefaults, proposalDefaultsSchema,
  resolveProposalTerms, validUntilFromDays,
} from "@/lib/location-proposal-settings";

describe("location proposal settings", () => {
  it("lets admin, manager and sales rep edit", () => {
    expect(canEditProposalSettings("admin")).toBe(true);
    expect(canEditProposalSettings("manager")).toBe(true);
    expect(canEditProposalSettings("sales_rep")).toBe(true);
    expect(canEditProposalSettings("accounts")).toBe(false);
    expect(canEditProposalSettings(undefined)).toBe(false);
  });

  it("accepts a coherent set of defaults", () => {
    const r = proposalDefaultsSchema.safeParse({ tenure_months: 12, lock_in_months: 11, notice_period_months: 1, security_deposit_months: 2, valid_days: 15 });
    expect(r.success).toBe(true);
  });

  it("rejects lock-in longer than the term and notice beyond what the term allows", () => {
    expect(proposalDefaultsSchema.safeParse({ tenure_months: 6, lock_in_months: 9 }).success).toBe(false);
    expect(proposalDefaultsSchema.safeParse({ tenure_months: 12, lock_in_months: 11, notice_period_months: 4 }).success).toBe(false);
  });

  it("rejects unknown keys and out-of-range numbers", () => {
    expect(proposalDefaultsSchema.safeParse({ foo: 1 }).success).toBe(false);
    expect(proposalDefaultsSchema.safeParse({ security_deposit_months: 99 }).success).toBe(false);
    expect(proposalDefaultsSchema.safeParse({ valid_days: 0 }).success).toBe(false);
  });

  it("cleans unset fields and collapses empty defaults to null", () => {
    expect(cleanProposalDefaults({ tenure_months: 12, valid_days: null })).toEqual({ tenure_months: 12 });
    expect(cleanProposalDefaults({ tenure_months: null })).toBeNull();
  });

  it("falls back to the standard terms when the location has none", () => {
    expect(resolveProposalTerms(null, "STD")).toBe("STD");
    expect(resolveProposalTerms("   ", "STD")).toBe("STD");
    expect(resolveProposalTerms("• Custom", "STD")).toBe("• Custom");
  });

  it("computes the validity date", () => {
    expect(validUntilFromDays(15, new Date(2026, 10, 13))).toBe("2026-11-28");
    expect(validUntilFromDays(30, new Date(2026, 11, 20))).toBe("2027-01-19");
  });
});
