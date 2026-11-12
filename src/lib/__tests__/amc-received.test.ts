import { describe, it, expect } from "vitest";
import { amcNotReceived } from "@/lib/procurement/amc-received";

describe("amcNotReceived", () => {
  it("warns until the item is received", () => {
    for (const status of ["pending", "ordered", "partially_received"]) {
      expect(amcNotReceived({ status })).toBe(true);
    }
  });
  it("is quiet once received, billed, or when terminated", () => {
    for (const status of ["received", "invoice_received", "invoice_approved"]) {
      expect(amcNotReceived({ status })).toBe(false);
    }
    expect(amcNotReceived({ status: "ordered", amc_terminated_at: "2026-11-01T00:00:00Z" })).toBe(false);
  });
});

import { assetGaps, assetsNeedingDetails } from "@/lib/procurement/amc-received";

describe("asset details", () => {
  it("lists what an asset lacks", () => {
    expect(assetGaps({ id: "a", name: "AC", serial_number: "S1", location_id: "l" })).toEqual([]);
    expect(assetGaps({ id: "a", name: " ", serial_number: null, location_id: null })).toEqual(["name", "serial number", "location"]);
  });
  it("flags an asset still at the Procured stage, but not an older asset with no stage", () => {
    const base = { id: "a", name: "AC", serial_number: "S", location_id: "l" };
    expect(assetGaps({ ...base, lifecycle_stage: "procured" })).toEqual(["receipt at the location (stage is still Procured)"]);
    expect(assetGaps({ ...base, lifecycle_stage: "operational" })).toEqual([]);
    expect(assetGaps({ ...base, lifecycle_stage: null })).toEqual([]);
  });
  it("lists each incomplete asset once", () => {
    const a = { id: "a", name: "AC", serial_number: null, location_id: "l" };
    const out = assetsNeedingDetails([a, a, { id: "b", name: "UPS", serial_number: "S", location_id: "l" }]);
    expect(out).toHaveLength(1);
    expect(out[0].gaps).toEqual(["serial number"]);
  });
});
