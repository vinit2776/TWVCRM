import { describe, expect, it } from "vitest";
import { retiredPoKind } from "@/components/procurement/retired-amc-banner";

describe("retiredPoKind", () => {
  it("flags a terminated AMC", () => {
    expect(retiredPoKind({ po_number: "P", status: "ordered", amc_terminated_at: "2026-11-01" })).toBe("terminated");
  });
  it("flags a cancelled PO", () => {
    expect(retiredPoKind({ po_number: "P", status: "cancelled" })).toBe("cancelled");
  });
  it("leaves a live PO alone", () => {
    expect(retiredPoKind({ po_number: "P", status: "ordered" })).toBeNull();
    expect(retiredPoKind(null)).toBeNull();
  });
});
