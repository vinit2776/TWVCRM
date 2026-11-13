import { beforeEach, describe, expect, it, vi } from "vitest";

const roll = vi.fn().mockResolvedValue({ outcome: "renewed", successorId: "new" });
vi.mock("@/lib/vo-renewal-completion", () => ({ rollCaseToNextTerm: (...a: unknown[]) => roll(...a) }));

import { rollPartnerRenewal } from "@/lib/vo-partner-renewal";

function client(caseRow: Record<string, unknown>) {
  const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: caseRow }) };
  return { from: () => chain } as never;
}

function caseWith(rec: Record<string, unknown>) {
  return {
    id: "c1",
    status: "active",
    end_date: "2026-11-30",
    aggregator_id: "a1",
    aggregator: { billing_method: "postpaid" },
    metadata: {
      partner_renewal: { term_start: "2026-12-01", by: "u", at: "x", note: "n", ...rec },
    },
  };
}

describe("rollPartnerRenewal stored rate", () => {
  beforeEach(() => roll.mockClear());

  it("stores the annual rate for a term over 12 months", async () => {
    await rollPartnerRenewal(
      client(caseWith({ term_end: "2028-11-30", duration_months: 24, new_rate: 18000, new_term_fee: 36000 })),
      { caseId: "c1", performedBy: null, today: "2026-12-01" },
    );
    expect(roll.mock.calls[0][1].rate).toBe(18000);
    expect(roll.mock.calls[0][1].months).toBe(24);
  });

  it("derives the fee for a confirmation recorded without new_term_fee", async () => {
    await rollPartnerRenewal(
      client(caseWith({ term_end: "2029-11-30", duration_months: 36, new_rate: 18000 })),
      { caseId: "c1", performedBy: null, today: "2026-12-01" },
    );
    expect(roll.mock.calls[0][1].rate).toBe(18000);
  });

  it("stores the rate unchanged for 12 months or less", async () => {
    await rollPartnerRenewal(
      client(caseWith({ term_end: "2027-11-30", duration_months: 12, new_rate: 2625, new_term_fee: 2625 })),
      { caseId: "c1", performedBy: null, today: "2026-12-01" },
    );
    expect(roll.mock.calls[0][1].rate).toBe(2625);
  });
});
