import { describe, it, expect } from "vitest";
import { compareProposalToRequest, type CompareRequest } from "@/lib/procurement/proposal-compare";
import type { ExtractedAmcProposal } from "@/lib/procurement/proposal-extraction";

const proposal = (over: Partial<ExtractedAmcProposal> = {}): ExtractedAmcProposal => ({
  vendorName: "Blue Star", proposalNumber: null, startDate: "2026-03-30", endDate: "2027-03-29", billingFrequency: null,
  billedInAdvance: null, visitsPerYear: 4, coverage: "comprehensive", valueBeforeGst: 19800, amountCandidates: [], gstPercent: 18,
  contactName: null, contactPhone: null, contactEmail: null, contactCandidates: [],
  equipment: [{ description: "AC", model: null, serial: "SER-1", capacity: null, rate: 19800 }], confidence: "high", ...over,
});
const request = (over: Partial<CompareRequest> = {}): CompareRequest => ({
  startDate: "2026-03-30", endDate: "2027-03-29", visitsCovered: 4, coverage: "comprehensive", openingCycles: 0,
  lines: [{ quantity: 1, perCycleCost: 19800, assetName: "AC", assetSerial: "ser 1" }], ...over,
});
const by = (rows: ReturnType<typeof compareProposalToRequest>, k: string) => rows.find((r) => r.key === k)!;

describe("proposal compare", () => {
  it("matches an AMC set up exactly as proposed", () => {
    expect(compareProposalToRequest(proposal(), request()).every((r) => r.status === "match")).toBe(true);
  });
  it("flags different dates, visits and coverage", () => {
    const rows = compareProposalToRequest(proposal(), request({ startDate: "2026-04-01", visitsCovered: 2, coverage: "labour_only" }));
    expect(by(rows, "period").status).toBe("differs");
    expect(by(rows, "visits").status).toBe("differs");
    expect(by(rows, "coverage").status).toBe("differs");
  });
  it("treats a lower value as information and a higher one as a difference", () => {
    expect(by(compareProposalToRequest(proposal(), request({ lines: [{ quantity: 1, perCycleCost: 18000, assetName: null, assetSerial: "SER-1" }] })), "value").status).toBe("info");
    expect(by(compareProposalToRequest(proposal(), request({ lines: [{ quantity: 1, perCycleCost: 21000, assetName: null, assetSerial: "SER-1" }] })), "value").status).toBe("differs");
  });
  it("counts the settled cycles in the contract value", () => {
    const rows = compareProposalToRequest(proposal({ valueBeforeGst: 19800 }), request({ openingCycles: 1, lines: [{ quantity: 1, perCycleCost: 9900, assetName: null, assetSerial: "SER-1" }] }));
    expect(by(rows, "value").status).toBe("match");
  });
  it("scales the yearly visits over a multi-year contract", () => {
    const rows = compareProposalToRequest(proposal({ startDate: "2026-04-01", endDate: "2028-03-31" }), request({ startDate: "2026-04-01", endDate: "2028-03-31", visitsCovered: 8 }));
    expect(by(rows, "visits").status).toBe("match");
  });
  it("matches serials ignoring spaces, case and dashes, and flags a missing one", () => {
    expect(by(compareProposalToRequest(proposal(), request()), "assets").status).toBe("match");
    const rows = compareProposalToRequest(proposal(), request({ lines: [{ quantity: 1, perCycleCost: 19800, assetName: "AC", assetSerial: "OTHER" }] }));
    expect(by(rows, "assets").status).toBe("differs");
    expect(by(rows, "assets").hint).toMatch(/SER-1/);
  });
  it("reports what the proposal does not state, rather than a difference", () => {
    const rows = compareProposalToRequest(proposal({ startDate: null, endDate: null, valueBeforeGst: null, coverage: null, visitsPerYear: null, equipment: [] }), request());
    expect(by(rows, "period").status).toBe("not_in_proposal");
    expect(by(rows, "value").status).toBe("not_in_proposal");
    expect(rows.find((r) => r.key === "coverage")).toBeUndefined();
  });
});
