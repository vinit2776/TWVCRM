import { describe, it, expect } from "vitest";
import { summarizeAuditEvent } from "../audit-labels";

describe("summarizeAuditEvent for an add-on ended early", () => {
  it("names the add-on, the last billed day and the reason", () => {
    const s = summarizeAuditEvent({
      entity_type: "contract",
      action: "contract_addon_ended",
      changes: {
        "Valet car parking: effective_until": { old: "2027-05-31", new: "2027-01-14" },
        "Valet car parking: reason": { old: null, new: "Customer gave up the slot, email of 9 Jan" },
      },
    });
    expect(s.label).toBe("Valet car parking billing ends 2027-01-14");
    expect(s.detail).toBe("Customer gave up the slot, email of 9 Jan");
    expect(s.tone).toBe("amber");
  });
});
