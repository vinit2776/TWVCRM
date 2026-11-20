import { describe, it, expect } from "vitest";
import { summariseSeenBefore, type SeenBeforeData } from "../seen-before";

const base: SeenBeforeData = {
  lead: { status: "new", lost_reason: null, junk_reason: null, owner_name: null },
  earlier: [],
  activities: [],
  proposals: [],
  contracts: [],
};
const future = "2999-01-01";

describe("summariseSeenBefore", () => {
  it("shows nothing for a first enquiry", () => {
    expect(summariseSeenBefore(base)).toEqual({ hasHistory: false, currentCustomer: false, closed: null, openProposals: 0 });
  });
  it("shows history once there is an earlier enquiry, call, proposal or contract", () => {
    expect(summariseSeenBefore({ ...base, earlier: [{ reference: "TWV-E-1", received_at: "2026-10-01" }] }).hasHistory).toBe(true);
    expect(summariseSeenBefore({ ...base, activities: [{ type: "call", subject: "Call", created_at: "2026-10-01" }] }).hasHistory).toBe(true);
    expect(summariseSeenBefore({ ...base, proposals: [{ proposal_number: "P-1", status: "sent" }] }).hasHistory).toBe(true);
  });
  it("flags a running contract as a current customer, but not an ended one", () => {
    expect(summariseSeenBefore({ ...base, contracts: [{ contract_number: "C-1", status: "active", end_date: future }] }).currentCustomer).toBe(true);
    expect(summariseSeenBefore({ ...base, contracts: [{ contract_number: "C-1", status: "expired", end_date: "2020-01-01" }] }).currentCustomer).toBe(false);
  });
  it("notes a closed lead and counts open proposals only", () => {
    const s = summariseSeenBefore({
      ...base,
      lead: { ...base.lead, status: "lost" },
      proposals: [{ proposal_number: "P-1", status: "sent" }, { proposal_number: "P-2", status: "rejected" }, { proposal_number: "P-3", status: "draft" }],
    });
    expect(s.closed).toBe("lost");
    expect(s.hasHistory).toBe(true);
    expect(s.openProposals).toBe(2);
  });
});
