import { describe, it, expect } from "vitest";
import { exceedsProposalCap, lineContractTotal, PROPOSAL_CAP_TOLERANCE } from "@/lib/procurement/proposal-cap";

describe("lineContractTotal", () => {
  it("counts cycles billed here plus those settled before", () => {
    expect(lineContractTotal(2, 2, 5000)).toBe(20000);
    expect(lineContractTotal(4, 0, 2500)).toBe(10000);
  });
});

describe("exceedsProposalCap", () => {
  const line = { quantity: 4, perCycleCost: 2500, cap: 10000 };
  it("allows the proposal value and anything lower", () => {
    expect(exceedsProposalCap(line, 0)).toBe(false);
    expect(exceedsProposalCap({ ...line, perCycleCost: 2000 }, 0)).toBe(false);
  });
  it("blocks anything higher", () => {
    expect(exceedsProposalCap({ ...line, perCycleCost: 2600 }, 0)).toBe(true);
  });
  it("tolerates a rupee of rounding but not more", () => {
    expect(exceedsProposalCap({ ...line, quantity: 3, perCycleCost: 3333.66 }, 0)).toBe(false);
    expect(exceedsProposalCap({ ...line, perCycleCost: 2500 + (PROPOSAL_CAP_TOLERANCE + 0.5) / 4 }, 0)).toBe(true);
  });
  it("counts settled cycles of a running contract against the ceiling", () => {
    // 2 left to bill + 2 already settled = 4 cycles in all
    expect(exceedsProposalCap({ quantity: 2, perCycleCost: 2600, cap: 10000 }, 2)).toBe(true);
    expect(exceedsProposalCap({ quantity: 2, perCycleCost: 2500, cap: 10000 }, 2)).toBe(false);
  });
  it("does nothing when the line has no proposal ceiling", () => {
    expect(exceedsProposalCap({ quantity: 4, perCycleCost: 99999, cap: null }, 0)).toBe(false);
    expect(exceedsProposalCap({ quantity: 4, perCycleCost: 99999, cap: undefined }, 0)).toBe(false);
  });
});
